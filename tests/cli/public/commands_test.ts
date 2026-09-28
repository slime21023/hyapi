import { assertEquals, assertStringIncludes } from "@std/assert";
import cliConfig from "../../../packages/cli/deno.json" with { type: "json" };

const cliEntry = new URL("../../../packages/cli/mod.ts", import.meta.url).href;
const decoder = new TextDecoder();

Deno.test("the public CLI facade exposes help and its package version", async () => {
  const help = await execute("--help");
  assertEquals(help.code, 0, help.stderr);
  assertStringIncludes(help.stdout, "hyapi generate module <name>");

  const version = await execute("--version");
  assertEquals(version.code, 0, version.stderr);
  assertEquals(version.stdout.trim(), cliConfig.version);
});

Deno.test("the public CLI facade creates a starter project", async () => {
  const root = await Deno.makeTempDir({ prefix: "hyapi-cli-public-" });
  try {
    const project = `${root}/store-api`;
    const result = await execute("new", project);
    assertEquals(result.code, 0, result.stderr);
    assertEquals((await Deno.stat(`${project}/src/app.ts`)).isFile, true);
    assertStringIncludes(
      await Deno.readTextFile(`${project}/deno.json`),
      `@hyapi/core@^${cliConfig.version}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function execute(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", "--allow-read", "--allow-write", cliEntry, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}
