// `hyapi emit --watch`: emits the documents, then again whenever a TypeScript module or `deno.json`
// in the project changes. Every run is a fresh process, because a process caches the modules it has
// imported and would not see a changed contract.
import type { Io } from "./report.ts";

/** The CLI's entry point, run again for every emit. */
const ENTRY = new URL("../mod.ts", import.meta.url).href;
/** Changes to these files can change a document; the documents themselves are not watched. */
const WATCHED = /\.(ts|tsx|mts)$|(^|[\\/])deno\.jsonc?$/;
const IGNORED = /[\\/](node_modules|\.git)[\\/]/;
/** Editors write a file in several steps; one emit follows a burst of changes. */
const DEBOUNCE_MS = 150;

function lines(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).split("\n").filter((line) => line !== "");
}

/** Runs `hyapi emit` once in a fresh process and relays its output. */
async function emitOnce(cwd: string, args: readonly string[], io: Io): Promise<number> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", ENTRY, "emit", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  lines(output.stdout).forEach((line) => io.out(line));
  lines(output.stderr).forEach((line) => io.err(line));
  return output.code;
}

const relevant = (path: string) => WATCHED.test(path) && !IGNORED.test(path);

/**
 * Emits, then emits again after every relevant change, until `signal` aborts. Returns 0 when it
 * stops; failed emits are reported and watching continues.
 */
export async function watchEmit(
  cwd: string,
  args: readonly string[],
  io: Io,
  signal?: AbortSignal,
): Promise<number> {
  await emitOnce(cwd, args, io);
  if (signal?.aborted) return 0;
  io.out("watching for changes; press Ctrl+C to stop");
  const watcher = Deno.watchFs(cwd, { recursive: true });
  signal?.addEventListener("abort", () => watcher.close(), { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> = Promise.resolve();
  const rerun = () => {
    running = running.then(() => emitOnce(cwd, args, io));
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(rerun, DEBOUNCE_MS);
  };
  for await (const event of watcher) if (event.paths.some(relevant)) schedule();
  clearTimeout(timer);
  await running;
  return 0;
}
