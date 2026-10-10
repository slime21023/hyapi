// What the CLI tests share: the repository root, and running the CLI with its output captured.
import { fromFileUrl } from "jsr:@std/path@^1";
import { run } from "@hyapi/cli";

/** The repository root, without a trailing separator. */
export const REPO: string = fromFileUrl(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");

/** Runs the CLI in `cwd` and returns its exit code and its output lines joined. */
export async function cli(args: readonly string[], cwd: string = REPO) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { cwd, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
