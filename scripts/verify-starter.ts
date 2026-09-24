import { main, VERSION } from "../packages/cli/mod.ts";
import rootConfig from "../deno.json" with { type: "json" };

const cliEntry = new URL("../packages/cli/mod.ts", import.meta.url).href;
const coreEntry = new URL("../packages/core/mod.ts", import.meta.url).href;
if (Deno.args.length > 1 || (Deno.args.length === 1 && Deno.args[0] !== "--published")) {
  throw new Error("Usage: verify-starter.ts [--published]");
}
const published = Deno.args[0] === "--published";

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

  if (!published) {
    // Pre-publication CI checks local source; this is not proof the JSR dependency exists.
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
  }

  const commands: readonly (readonly string[])[] = [
    ["task", "verify"],
    ["run", "--allow-read", cliEntry, "doctor", project],
  ];
  for (const args of commands) {
    const result = await new Deno.Command(Deno.execPath(), { args: [...args], cwd: project })
      .output();
    if (result.code !== 0) {
      const decoder = new TextDecoder();
      console.log(decoder.decode(result.stdout));
      const stderr = decoder.decode(result.stderr);
      console.error(stderr);
      if (published && stderr.includes("JSR package not found: @hyapi/core")) {
        throw new Error(
          `The generated starter cannot resolve jsr:@hyapi/core@^${VERSION}. ` +
            "Publish @hyapi/core before verifying an independent starter.",
        );
      }
      throw new Error(`Starter verification failed: deno ${args.join(" ")}`);
    }
  }
  console.log(
    published
      ? "Unmodified published starter verified: verify and doctor passed."
      : "Local-source starter verified: verify and doctor passed. " +
        "JSR availability was not checked; run with --published after publishing @hyapi/core.",
  );
} finally {
  await Deno.remove(root, { recursive: true });
}
