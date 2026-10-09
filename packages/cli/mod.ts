/**
 * The HyAPI command-line tool: `new`, `emit`, and `doctor`.
 *
 * ```text
 * deno run -A jsr:@hyapi/cli emit [--api <module#export>] [--out <file>] [--check]
 * ```
 *
 * @module
 */
import { run } from "./src/run.ts";

export { run, type RunOptions } from "./src/run.ts";

if (import.meta.main) Deno.exit(await run(Deno.args));
