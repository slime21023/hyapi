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

  // Exercise the listener's real socket and shutdown callback, even on Windows where
  // ChildProcess.kill("SIGINT") terminates the child instead of delivering its listener.
  const reservation = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (reservation.addr as Deno.NetAddr).port;
  reservation.close();
  const check = `
    const ready = Promise.withResolvers<() => void>();
    const register = Deno.addSignalListener;
    Deno.addSignalListener = (signal, listener) => {
      register(signal, listener);
      if (signal === "SIGINT") ready.resolve(listener);
    };
    const running = import("./src/main.ts");
    const stop = await Promise.race([
      ready.promise,
      running.then(() => { throw new Error("Listener exited before registering shutdown."); }),
    ]);
    const response = await fetch("http://127.0.0.1:${port}/health/live");
    if (response.status !== 200 || (await response.json()).status !== "ok") {
      throw new Error("Generated listener did not serve GET /health/live.");
    }
    stop();
    await running;
  `;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--unstable-no-legacy-abort", check],
    cwd: project,
    env: { PORT: String(port) },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = child.output();
  const shutdown = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => shutdown.reject(new Error("Generated listener did not shut down.")),
    10_000,
  );
  let finished = false;
  try {
    const result = await Promise.race([output, shutdown.promise]);
    finished = true;
    if (result.code !== 0) {
      throw new Error(
        `Generated listener exited ${result.code}: ${new TextDecoder().decode(result.stderr)}`,
      );
    }
  } finally {
    clearTimeout(timer);
    if (!finished) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      await output;
    }
  }
  console.log(
    published
      ? "Unmodified published starter verified: verify, doctor, listener, and shutdown passed."
      : "Local-source starter verified: verify, doctor, listener, and shutdown passed. " +
        "JSR availability was not checked; run with --published after publishing @hyapi/core.",
  );
} finally {
  await Deno.remove(root, { recursive: true });
}
