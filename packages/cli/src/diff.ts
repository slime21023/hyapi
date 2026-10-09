import { relative } from "jsr:@std/path@^1";
import { parse as parseYaml } from "jsr:@std/yaml@^1.0.12";
import { type DiffFormat, diffOpenApi, formatDiff } from "@hyapi/openapi-diff";
import { UsageError } from "./config.ts";
import { compileProject } from "./emit.ts";
import type { Io } from "./run.ts";

/** The branch every change is compared against. */
const BASE_BRANCHES = ["main", "origin/main"] as const;

async function git(cwd: string, args: string[]) {
  const output = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" })
    .output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/**
 * Reads the committed document from the `main` branch (or `origin/main`, as CI checkouts often
 * have only the remote branch). Returns `null` when the branch exists but has no document yet.
 */
async function readBase(
  cwd: string,
  documentPath: string,
): Promise<{ text: string; ref: string } | null> {
  const path = `./${relative(cwd, documentPath).replaceAll("\\", "/")}`;
  for (const ref of BASE_BRANCHES) {
    if (!(await git(cwd, ["rev-parse", "--verify", "--quiet", ref])).success) continue;
    const shown = await git(cwd, ["show", `${ref}:${path}`]);
    if (shown.success) return { text: shown.stdout, ref };
    if (/does not exist|exists on disk, but not in/.test(shown.stderr)) return null;
    throw new UsageError(`cannot read ${path} from ${ref}: ${shown.stderr.trim()}`);
  }
  throw new UsageError(
    "no 'main' or 'origin/main' branch to compare against; in CI, fetch it first " +
      "(for example 'git fetch origin main')",
  );
}

/**
 * `hyapi diff`: compares the API compiled from the current contracts with the document committed
 * on `main`, and fails on breaking changes unless `--allow-breaking` is given.
 */
export async function diffCommand(
  cwd: string,
  flags: {
    readonly api?: string;
    readonly out?: string;
    readonly format: DiffFormat;
    readonly allowBreaking: boolean;
  },
  io: Io,
): Promise<number> {
  const compiled = await compileProject(cwd, flags, io);
  if (compiled === undefined) return 1;
  const head = compiled.document;
  const base = await readBase(cwd, compiled.documentPath);
  const baseDocument = base === null
    ? { openapi: head.openapi, info: head.info, paths: {} }
    : /\.ya?ml$/i.test(compiled.documentPath)
    ? parseYaml(base.text)
    : JSON.parse(base.text);
  if (base === null) io.err("note: main has no committed document yet; every operation is new");

  const result = diffOpenApi(baseDocument, head);
  if (!result.ok) {
    for (const error of result.errors) io.err(`error: ${error}`);
    return 1;
  }
  io.out(formatDiff(result, flags.format).trimEnd());
  if (result.breaking > 0 && !flags.allowBreaking) {
    io.err(
      `${result.breaking} breaking change(s) against ${base?.ref ?? "main"}; ` +
        "if they are intended, rerun with --allow-breaking",
    );
    return 1;
  }
  return 0;
}
