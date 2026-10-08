import { dirname, relative } from "jsr:@std/path@^1";
import { checkContracts, type ContractModel } from "@hyapi/core/contract";
import { emitOpenApi } from "@hyapi/core/openapi";
import { resolveProject } from "./config.ts";
import { serialize } from "./document.ts";
import { loadApi } from "./load.ts";
import { formatDiagnostic } from "./report.ts";
import type { Io } from "./run.ts";

/** Loads, checks, and serializes the project's API. Undefined when the contracts have errors. */
export async function compileProject(
  cwd: string,
  flags: { readonly api?: string; readonly out?: string },
  io: Io,
): Promise<{ model: ContractModel; text: string; documentPath: string } | undefined> {
  const project = await resolveProject(cwd, flags);
  const result = checkContracts(await loadApi(project.apiModule, project.apiExport));
  for (const diagnostic of result.diagnostics) io.err(formatDiagnostic(diagnostic));
  if (!result.ok) return undefined;
  return {
    model: result.model,
    text: serialize(emitOpenApi(result.model), project.format),
    documentPath: project.documentPath,
  };
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

/** `hyapi emit`: writes the OpenAPI document, or with `--check` verifies that it is current. */
export async function emitCommand(
  cwd: string,
  flags: { readonly api?: string; readonly out?: string; readonly check: boolean },
  io: Io,
): Promise<number> {
  const compiled = await compileProject(cwd, flags, io);
  if (compiled === undefined) return 1;
  const shown = relative(cwd, compiled.documentPath) || compiled.documentPath;
  if (flags.check) {
    const current = await readDocument(compiled.documentPath);
    if (current === compiled.text) {
      io.out(`${shown} is up to date`);
      return 0;
    }
    io.err(
      current === undefined
        ? `${shown} does not exist; run hyapi emit and commit it`
        : `${shown} is out of date; run hyapi emit and commit the result`,
    );
    return 1;
  }
  await Deno.mkdir(dirname(compiled.documentPath), { recursive: true });
  await Deno.writeTextFile(compiled.documentPath, compiled.text);
  io.out(`wrote ${shown}`);
  return 0;
}
