import { relative } from "jsr:@std/path@^1";
import { parse as parseYaml } from "jsr:@std/yaml@^1.0.12";
import { type DiffFormat, diffOpenApi, type DiffResult, formatDiff } from "@hyapi/openapi-diff";
import { UsageError } from "./config.ts";
import { type Compiled, compileProject } from "./emit.ts";
import type { Io } from "./run.ts";

/** The branches compared against when `--base` is not given. */
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

/** The first of `refs` that exists in the repository. */
async function resolveRef(cwd: string, refs: readonly string[], explicit: boolean) {
  for (const ref of refs) {
    if ((await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).success) {
      return ref;
    }
  }
  throw new UsageError(
    explicit
      ? `--base '${refs[0]}' is not a branch, tag, or commit in this repository`
      : "no 'main' or 'origin/main' branch to compare against; in CI, fetch it first " +
        "(for example 'git fetch origin main'), or pass --base <ref>",
  );
}

/** Reads a committed document at `ref`; undefined when the ref has no such file yet. */
async function readBase(cwd: string, ref: string, documentPath: string) {
  const path = `./${relative(cwd, documentPath).replaceAll("\\", "/")}`;
  const shown = await git(cwd, ["show", `${ref}:${path}`]);
  if (shown.success) return shown.stdout;
  if (/does not exist|exists on disk, but not in/.test(shown.stderr)) return undefined;
  throw new UsageError(`cannot read ${path} from ${ref}: ${shown.stderr.trim()}`);
}

/** Compares one document with its committed version at `ref`. */
async function diffDocument(
  compiled: Compiled,
  cwd: string,
  ref: string,
  io: Io,
  label: string,
): Promise<DiffResult> {
  const head = compiled.document;
  const path = compiled.files[0]!.path;
  const text = await readBase(cwd, ref, path);
  if (text === undefined) {
    io.err(`${label}note: ${ref} has no committed document yet; every operation is new`);
  }
  const base = text === undefined
    ? { openapi: head.openapi, info: head.info, paths: {} }
    : /\.ya?ml$/i.test(path)
    ? parseYaml(text)
    : JSON.parse(text);
  return diffOpenApi(base, head);
}

/** Prints the results: as before for one document, and per document for several. */
function report(
  results: readonly { readonly name: string; readonly result: DiffResult & { ok: true } }[],
  format: DiffFormat,
  io: Io,
): void {
  if (results.length === 1) {
    io.out(formatDiff(results[0]!.result, format).trimEnd());
    return;
  }
  if (format === "json") {
    const documents = Object.fromEntries(
      results.map(({ name, result }) => [name, JSON.parse(formatDiff(result, "json"))]),
    );
    io.out(JSON.stringify({ documents }, null, 2));
    return;
  }
  const heading = format === "markdown"
    ? (name: string) => `## ${name}`
    : (name: string) => `== ${name} ==`;
  io.out(
    results.map(({ name, result }) => `${heading(name)}\n\n${formatDiff(result, format).trimEnd()}`)
      .join("\n\n"),
  );
}

/**
 * `hyapi diff`: compares the documents compiled from the current contracts with the documents
 * committed on `main` (or `--base`), and fails on breaking changes unless `--allow-breaking` is
 * given.
 */
export async function diffCommand(
  cwd: string,
  flags: {
    readonly api?: string;
    readonly out?: string;
    readonly document?: string;
    readonly base?: string;
    readonly format: DiffFormat;
    readonly allowBreaking: boolean;
  },
  io: Io,
): Promise<number> {
  const compiled = await compileProject(cwd, flags, io);
  if (compiled === undefined) return 1;
  const explicit = flags.base !== undefined;
  const ref = await resolveRef(cwd, explicit ? [flags.base!] : BASE_BRANCHES, explicit);
  const results = [];
  for (const document of compiled) {
    const label = compiled.length > 1 ? `[${document.target.name}] ` : "";
    const result = await diffDocument(document, cwd, ref, io, label);
    if (!result.ok) {
      result.errors.forEach((error) => io.err(`${label}error: ${error}`));
      return 1;
    }
    results.push({ name: document.target.name, result });
  }
  report(results, flags.format, io);
  const breaking = results.reduce((sum, { result }) => sum + result.breaking, 0);
  if (breaking > 0 && !flags.allowBreaking) {
    io.err(
      `${breaking} breaking change(s) against ${ref}; if they are intended, rerun with ` +
        "--allow-breaking",
    );
    return 1;
  }
  return 0;
}
