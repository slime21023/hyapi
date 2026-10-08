import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "jsr:@std/yaml@^1.0.12";
import { fromFileUrl, join } from "jsr:@std/path@^1";
import { run } from "@hyapi/cli";

const repo = fromFileUrl(new URL("../../..", import.meta.url)).replace(/[\\/]$/, "");
const fixture = join(repo, "tests", "fixtures", "library_api.ts");
const golden = join(repo, "tests", "fixtures", "library_api.openapi.json");

async function cli(args: string[], cwd = repo) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { cwd, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "hyapi-cli-" });
}

Deno.test("emit writes the canonical JSON document", async () => {
  const dir = await tempDir();
  const out = join(dir, "nested", "openapi.json");
  const result = await cli(["emit", "--api", `${fixture}#api`, "--out", out]);
  assertEquals(result.code, 0, result.err);
  assertEquals(await Deno.readTextFile(out), await Deno.readTextFile(golden));
});

Deno.test("emit --check passes when current and fails when stale or missing", async () => {
  const dir = await tempDir();
  const out = join(dir, "openapi.json");
  const args = ["emit", "--api", `${fixture}#api`, "--out", out];
  assertEquals((await cli([...args, "--check"])).code, 1, "missing");
  assertEquals((await cli(args)).code, 0);
  const current = await cli([...args, "--check"]);
  assertEquals(current.code, 0);
  assertStringIncludes(current.out, "is up to date");
  await Deno.writeTextFile(out, (await Deno.readTextFile(out)).replace("1.2.0", "1.1.0"));
  const stale = await cli([...args, "--check"]);
  assertEquals(stale.code, 1);
  assertStringIncludes(stale.err, "is out of date");
  // CRLF checkouts are not treated as stale.
  await cli(args);
  await Deno.writeTextFile(out, (await Deno.readTextFile(out)).replaceAll("\n", "\r\n"));
  assertEquals((await cli([...args, "--check"])).code, 0);
});

Deno.test("emit writes YAML that round-trips, is deterministic, and is formatter-stable", async () => {
  const dir = await tempDir();
  const out = join(dir, "openapi.yaml");
  assertEquals((await cli(["emit", "--api", `${fixture}#api`, "--out", out])).code, 0);
  const first = await Deno.readTextFile(out);
  assertEquals((await cli(["emit", "--api", `${fixture}#api`, "--out", out])).code, 0);
  assertEquals(await Deno.readTextFile(out), first);
  assertEquals(parseYaml(first), JSON.parse(await Deno.readTextFile(golden)));
  const fmt = await new Deno.Command("deno", { args: ["fmt", "--check", out] }).output();
  assert(fmt.success, new TextDecoder().decode(fmt.stderr));
});

Deno.test("emit reads deno.json and flags override it", async () => {
  const dir = await tempDir();
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ hyapi: { api: `${fixture}#api`, openapi: "./docs/openapi.json" } }),
  );
  assertEquals((await cli(["emit"], dir)).code, 0);
  assertEquals(
    await Deno.readTextFile(join(dir, "docs", "openapi.json")),
    await Deno.readTextFile(golden),
  );
  assertEquals((await cli(["emit", "--out", "other.yaml"], dir)).code, 0);
  assert((await Deno.stat(join(dir, "other.yaml"))).isFile);
});

Deno.test("emit reports contract errors and writes nothing", async () => {
  const dir = await tempDir();
  const out = join(dir, "openapi.json");
  const broken = join(repo, "tests", "fixtures", "broken_api.ts");
  const result = await cli(["emit", "--api", `${broken}#api`, "--out", out]);
  assertEquals(result.code, 1);
  assertStringIncludes(result.err, "error [unknown-format] a (a/responses/200/body)");
  assertStringIncludes(result.err, "error [duplicate-route] b");
  assertEquals(await Deno.stat(out).catch(() => undefined), undefined);
});

Deno.test("usage errors exit with 2", async () => {
  const dir = await tempDir();
  for (
    const [args, message] of [
      [["emit"], "no API module"],
      [["emit", "--api", `${fixture}#api`, "--out", "x.txt"], "must end in .json"],
      [["emit", "--api", `${fixture}#missing`, "--out", "x.json"], "does not export"],
      [["emit", "--wat", "1"], "unknown option --wat"],
      [["publish"], "unknown command"],
      [["new"], "exactly one directory"],
    ] as const
  ) {
    const result = await cli([...args], dir);
    assertEquals(result.code, 2, args.join(" "));
    assertStringIncludes(result.err, message);
  }
  assertEquals((await cli([])).code, 2);
  assertEquals((await cli(["help"])).code, 0);
});

Deno.test("doctor checks the committed document and lists undocumented framework statuses", async () => {
  const dir = await tempDir();
  const out = join(dir, "openapi.json");
  const args = ["doctor", "--api", `${fixture}#api`, "--out", out];
  const missing = await cli(args);
  assertEquals(missing.code, 1);
  assertStringIncludes(missing.err, "does not exist");
  await Deno.copyFile(golden, out);
  const healthy = await cli(args);
  assertEquals(healthy.code, 0, healthy.err);
  assertStringIncludes(
    healthy.out,
    "do not declare 400, which the runtime returns for invalid input",
  );
  assertStringIncludes(healthy.out, "doctor: 6 operations, no problems");
});

Deno.test("new creates a starter that passes its own verification", async () => {
  const dir = join(await tempDir(), "demo");
  const created = await cli(["new", dir, "--local", repo]);
  assertEquals(created.code, 0, created.err);
  assert((await Deno.stat(join(dir, "openapi.json"))).isFile);
  const verify = await new Deno.Command("deno", { args: ["task", "verify"], cwd: dir }).output();
  const output = new TextDecoder().decode(verify.stdout) + new TextDecoder().decode(verify.stderr);
  assert(verify.success, output);
  assertStringIncludes(output, "openapi.json is up to date");
  const workflow = await Deno.readTextFile(join(dir, ".github", "workflows", "ci.yml"));
  assertStringIncludes(workflow, "deno task diff");
  // The starter's diff task runs once the project is a git repository with a main branch.
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "init"]]) {
    const git = await new Deno.Command("git", {
      args: ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      cwd: dir,
    }).output();
    assert(git.success, new TextDecoder().decode(git.stderr));
  }
  const diff = await new Deno.Command("deno", { args: ["task", "diff"], cwd: dir }).output();
  const diffOutput = new TextDecoder().decode(diff.stdout) + new TextDecoder().decode(diff.stderr);
  assert(diff.success, diffOutput);
  assertStringIncludes(diffOutput, "0 breaking, 0 non-breaking change(s)");
  assertEquals((await cli(["new", dir, "--local", repo])).code, 2, "refuses a non-empty directory");
});
