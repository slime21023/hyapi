import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "jsr:@std/path@^1";
import { cli, REPO } from "../helpers.ts";

const fixture = join(REPO, "tests", "fixtures", "library_api.ts");
const golden = JSON.parse(
  await Deno.readTextFile(join(REPO, "tests", "fixtures", "library_api.openapi.json")),
);

async function git(cwd: string, ...args: string[]) {
  const output = await new Deno.Command("git", {
    args: ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
}

/** A git project whose `main` branch has `base` committed as its OpenAPI document. */
async function project(base: unknown | undefined, branch = "main"): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "hyapi-diff-" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ hyapi: { api: `${fixture}#api`, openapi: "./openapi.json" } }),
  );
  await git(dir, "init", "-q", "-b", branch);
  if (base !== undefined) await Deno.writeTextFile(join(dir, "openapi.json"), JSON.stringify(base));
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "base");
  return dir;
}

function diff(dir: string, ...args: string[]) {
  return cli(["diff", ...args], dir);
}

Deno.test("no changes against an identical document on main", async () => {
  const result = await diff(await project(golden));
  assertEquals(result.code, 0, result.err);
  assertStringIncludes(result.out, "0 breaking, 0 non-breaking change(s)");
});

Deno.test("breaking changes fail unless --allow-breaking is given", async () => {
  // main had an extra operation that the current contracts no longer declare.
  const base = structuredClone(golden);
  base.paths["/legacy"] = {
    get: { operationId: "legacy", responses: { "200": { description: "OK" } } },
  };
  const dir = await project(base);
  const failed = await diff(dir);
  assertEquals(failed.code, 1);
  assertStringIncludes(failed.out, "BREAKING  GET /legacy · operation: the operation was removed");
  assertStringIncludes(failed.err, "1 breaking change(s) against main");
  const allowed = await diff(dir, "--allow-breaking", "--format", "markdown");
  assertEquals(allowed.code, 0);
  assertStringIncludes(allowed.out, "### Breaking changes");
});

Deno.test("non-breaking changes pass and are listed", async () => {
  const base = structuredClone(golden);
  delete base.paths["/export"];
  const result = await diff(await project(base), "--format", "json");
  assertEquals(result.code, 0);
  const parsed = JSON.parse(result.out);
  assertEquals(parsed.changes.map((c: { rule: string }) => c.rule), ["operation-added"]);
});

Deno.test("a project without a committed document compares against an empty API", async () => {
  const result = await diff(await project(undefined));
  assertEquals(result.code, 0);
  assertStringIncludes(result.err, "main has no committed document yet");
  assertStringIncludes(result.out, "0 breaking, 6 non-breaking change(s)");
});

Deno.test("a repository without main is a usage error", async () => {
  const result = await diff(await project(golden, "trunk"));
  assertEquals(result.code, 2);
  assertStringIncludes(result.err, "no 'main' or 'origin/main' branch");
});

Deno.test("--format is validated", async () => {
  const result = await diff(await project(golden), "--format", "xml");
  assertEquals(result.code, 2);
  assertStringIncludes(result.err, "--format must be text, markdown, or json");
});
