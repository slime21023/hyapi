import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "jsr:@std/path@^1";
import { run } from "@hyapi/cli";

const repo = fromFileUrl(new URL("../../..", import.meta.url)).replace(/[\\/]$/, "");
const library = join(repo, "tests", "fixtures", "library_api.ts");
const documents = join(repo, "tests", "fixtures", "documents_api.ts");

async function cli(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { cwd, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A project whose deno.json declares `hyapi`. */
async function project(hyapi: unknown): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "hyapi-documents-" });
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ hyapi }));
  return dir;
}

const twoDocuments = {
  documents: [
    {
      name: "internal",
      api: `${library}#api`,
      openapi: ["./openapi.json", "./openapi.yaml"],
    },
    { name: "public", api: `${documents}#publicApi`, openapi: "./public/openapi.json" },
  ],
};

async function git(cwd: string, ...args: string[]) {
  const output = await new Deno.Command("git", {
    args: ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success, new TextDecoder().decode(output.stderr));
}

Deno.test("emit writes every file of every document, and --check checks them all", async () => {
  const dir = await project(twoDocuments);
  const written = await cli(["emit"], dir);
  assertEquals(written.code, 0, written.err);
  for (const file of ["openapi.json", "openapi.yaml", "public/openapi.json"]) {
    assert((await Deno.stat(join(dir, file))).isFile, file);
  }
  const publicDocument = JSON.parse(await Deno.readTextFile(join(dir, "public", "openapi.json")));
  assertEquals(publicDocument.info.title, "Library API (public)");
  assertEquals(Object.keys(publicDocument.paths).includes("/health"), false);

  assertEquals((await cli(["emit", "--check"], dir)).code, 0);
  await Deno.writeTextFile(join(dir, "openapi.yaml"), "stale: true\n");
  const stale = await cli(["emit", "--check"], dir);
  assertEquals(stale.code, 1);
  assertStringIncludes(stale.err, "openapi.yaml is out of date");
  assertStringIncludes(stale.out, "openapi.json is up to date");
  const one = await cli(["emit", "--check", "--document", "public"], dir);
  assertEquals(one.code, 0, "--document checks only the named document");
});

Deno.test("configuration errors are usage errors", async () => {
  const cases: [unknown, string[], string][] = [
    [{ api: `${library}#api`, openapi: "x.json", documents: [] }, ["emit"], "not both"],
    [{ documents: [] }, ["emit"], "at least one"],
    [
      {
        documents: [{ name: "a", api: `${library}#api`, openapi: "a.json" }, {
          name: "a",
          api: `${library}#api`,
          openapi: "b.json",
        }],
      },
      ["emit"],
      "lists 'a' twice",
    ],
    [twoDocuments, ["emit", "--document", "missing"], "no document named 'missing'"],
    [twoDocuments, ["emit", "--document", "public", "--out", "x.json"], "omit --api and --out"],
  ];
  for (const [hyapi, args, message] of cases) {
    const result = await cli(args, await project(hyapi));
    assertEquals(result.code, 2, message);
    assertStringIncludes(result.err, message);
  }
});

Deno.test("doctor checks every document and that documents agree", async () => {
  const dir = await project(twoDocuments);
  assertEquals((await cli(["emit"], dir)).code, 0);
  const healthy = await cli(["doctor"], dir);
  assertEquals(healthy.code, 0, healthy.err);
  assertStringIncludes(healthy.out, "[public] info:");
  assertStringIncludes(healthy.out, "doctor: 2 documents, 6 operations, no problems");

  const conflicting = await project({
    documents: [
      ...twoDocuments.documents,
      { name: "other", api: `${documents}#conflictingApi`, openapi: "./other.json" },
    ],
  });
  assertEquals((await cli(["emit"], conflicting)).code, 0);
  const result = await cli(["doctor"], conflicting);
  assertEquals(result.code, 1);
  assertStringIncludes(
    result.err,
    "operationId 'listBooks' is GET /books in 'internal' but GET /catalog in 'other'",
  );
});

Deno.test("diff compares every document, and --base picks the reference", async () => {
  const dir = await project(twoDocuments);
  assertEquals((await cli(["emit"], dir)).code, 0);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "base");
  await git(dir, "tag", "v1");

  const text = await cli(["diff"], dir);
  assertEquals(text.code, 0, text.err);
  assertStringIncludes(text.out, "== internal ==");
  assertStringIncludes(text.out, "== public ==");

  const json = await cli(["diff", "--format", "json", "--base", "v1"], dir);
  assertEquals(json.code, 0, json.err);
  assertEquals(Object.keys(JSON.parse(json.out).documents), ["internal", "public"]);

  const unknown = await cli(["diff", "--base", "no-such-ref"], dir);
  assertEquals(unknown.code, 2);
  assertStringIncludes(unknown.err, "--base 'no-such-ref' is not a branch, tag, or commit");
});
