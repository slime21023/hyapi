import { main } from "../packages/cli/mod.ts";
import rootConfig from "../deno.json" with { type: "json" };

const cliEntry = new URL("../packages/cli/mod.ts", import.meta.url).href;
const coreEntry = new URL("../packages/core/mod.ts", import.meta.url).href;

const root = await Deno.makeTempDir({ prefix: "hyapi-starter-" });
const project = `${root}/starter`;

try {
  await main(["new", project], () => undefined);

  const originalCwd = Deno.cwd();
  Deno.chdir(project);
  try {
    await main(["generate", "module", "billing"], () => undefined);
  } finally {
    Deno.chdir(originalCwd);
  }

  const configPath = `${project}/deno.json`;
  const generated = JSON.parse(await Deno.readTextFile(configPath)) as {
    imports?: Record<string, string>;
  };
  generated.imports = {
    ...rootConfig.imports,
    ...generated.imports,
    "@hyapi/core": coreEntry,
  };
  await Deno.writeTextFile(configPath, `${JSON.stringify(generated, null, 2)}\n`);

  const commands: readonly (readonly string[])[] = [
    ["check", "src/main.ts"],
    ["test"],
    ["run", "--allow-read", cliEntry, "doctor", project],
  ];
  for (const args of commands) {
    const result = await new Deno.Command(Deno.execPath(), { args: [...args], cwd: project })
      .output();
    if (result.code !== 0) {
      const decoder = new TextDecoder();
      console.log(decoder.decode(result.stdout));
      console.error(decoder.decode(result.stderr));
      throw new Error(`Starter verification failed: deno ${args.join(" ")}`);
    }
  }
  console.log("Starter project verified: check, test, and doctor passed.");
} finally {
  await Deno.remove(root, { recursive: true });
}
