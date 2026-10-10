import { dirname, relative } from "jsr:@std/path@^1";
import { checkContracts } from "@hyapi/core/contract";
import { emitOpenApi, type OpenApiDocument } from "@hyapi/core/openapi";
import { type DocumentFlags, type DocumentTarget, resolveDocuments } from "./config.ts";
import { serialize } from "./document.ts";
import { loadApi } from "./load.ts";
import { formatDiagnostic, type Io } from "./report.ts";

/** A document compiled from its contracts, with the text of each output file. */
export interface Compiled {
  readonly target: DocumentTarget;
  readonly document: OpenApiDocument;
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

/** Prefixes output lines with the document name when a command works on several documents. */
export function labelFor(targets: readonly DocumentTarget[]): (target: DocumentTarget) => string {
  return targets.length > 1 ? (target) => `[${target.name}] ` : () => "";
}

/** Loads, checks, and serializes one document. Undefined when its contracts have errors. */
async function compile(
  target: DocumentTarget,
  label: string,
  io: Io,
): Promise<Compiled | undefined> {
  const api = await loadApi(target.apiModule, target.apiExport);
  const result = checkContracts(api);
  for (const diagnostic of result.diagnostics) io.err(`${label}${formatDiagnostic(diagnostic)}`);
  if (!result.ok) return undefined;
  const document = emitOpenApi(api);
  const files = target.outputs.map(({ path, format }) => ({
    path,
    text: serialize(document, format),
  }));
  return { target, document, files };
}

/**
 * Compiles every selected document, reporting each one's diagnostics. Undefined when any document
 * has contract errors.
 */
export async function compileProject(
  cwd: string,
  flags: DocumentFlags,
  io: Io,
): Promise<Compiled[] | undefined> {
  const targets = await resolveDocuments(cwd, flags);
  const label = labelFor(targets);
  const compiled: Compiled[] = [];
  let failed = false;
  for (const target of targets) {
    const result = await compile(target, label(target), io);
    if (result === undefined) failed = true;
    else compiled.push(result);
  }
  return failed ? undefined : compiled;
}

/** Reads a document with normalized line endings; undefined when it does not exist. */
export async function readDocument(path: string): Promise<string | undefined> {
  try {
    return (await Deno.readTextFile(path)).replaceAll("\r\n", "\n");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** Compares one committed file with its emitted text; reports and returns whether it is current. */
async function checkFile(
  file: { readonly path: string; readonly text: string },
  shown: string,
  io: Io,
): Promise<boolean> {
  const current = await readDocument(file.path);
  if (current === file.text) {
    io.out(`${shown} is up to date`);
    return true;
  }
  io.err(
    current === undefined
      ? `${shown} does not exist; run hyapi emit and commit it`
      : `${shown} is out of date; run hyapi emit and commit the result`,
  );
  return false;
}

/** `hyapi emit`: writes every document, or with `--check` verifies that each one is current. */
export async function emitCommand(
  cwd: string,
  flags: DocumentFlags & { readonly check: boolean },
  io: Io,
): Promise<number> {
  const compiled = await compileProject(cwd, flags, io);
  if (compiled === undefined) return 1;
  let stale = 0;
  for (const file of compiled.flatMap((document) => document.files)) {
    const shown = relative(cwd, file.path) || file.path;
    if (flags.check) {
      stale += (await checkFile(file, shown, io)) ? 0 : 1;
      continue;
    }
    await Deno.mkdir(dirname(file.path), { recursive: true });
    await Deno.writeTextFile(file.path, file.text);
    io.out(`wrote ${shown}`);
  }
  return stale === 0 ? 0 : 1;
}
