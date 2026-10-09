import { relative } from "jsr:@std/path@^1";
import type { OpenApiDocument } from "@hyapi/core/openapi";
import { compileProject, readDocument } from "./emit.ts";
import type { Io } from "./run.ts";

const METHODS = ["get", "head", "post", "put", "patch", "delete", "options", "trace"];

interface DocumentOperation {
  readonly operationId: string;
  readonly hasParameters: boolean;
  readonly hasBody: boolean;
  readonly statuses: ReadonlySet<number>;
}

/** The operations of an emitted document, in document order. */
function operationsOf(document: OpenApiDocument): DocumentOperation[] {
  const operations: DocumentOperation[] = [];
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const item of Object.values(paths)) {
    for (const method of METHODS) {
      const operation = item[method] as Record<string, unknown> | undefined;
      if (operation === undefined) continue;
      operations.push({
        operationId: String(operation.operationId),
        hasParameters: Array.isArray(operation.parameters) && operation.parameters.length > 0,
        hasBody: operation.requestBody !== undefined,
        statuses: new Set(Object.keys(operation.responses ?? {}).map(Number)),
      });
    }
  }
  return operations;
}

/** Statuses the runtime can produce for an operation, with the reason for each. */
function frameworkStatuses(operation: DocumentOperation): [number, string][] {
  const statuses: [number, string][] = [];
  if (operation.hasParameters || operation.hasBody) statuses.push([400, "invalid input"]);
  if (operation.hasBody) {
    statuses.push([413, "an oversized body"], [415, "an undeclared media type"]);
  }
  statuses.push([500, "unexpected errors"], [503, "request timeouts"]);
  return statuses;
}

/**
 * `hyapi doctor`: checks the contracts and the committed document without starting a server, and
 * lists framework responses that the contracts do not document.
 */
export async function doctorCommand(
  cwd: string,
  flags: { readonly api?: string; readonly out?: string },
  io: Io,
): Promise<number> {
  const compiled = await compileProject(cwd, flags, io);
  if (compiled === undefined) {
    io.err("doctor: the contracts have errors");
    return 1;
  }
  let problems = 0;
  const shown = relative(cwd, compiled.documentPath) || compiled.documentPath;
  const current = await readDocument(compiled.documentPath);
  if (current === undefined) {
    io.err(`error: ${shown} does not exist; run hyapi emit`);
    problems++;
  } else if (current !== compiled.text) {
    io.err(`error: ${shown} is out of date; run hyapi emit`);
    problems++;
  }

  const missing = new Map<number, { reason: string; operations: string[] }>();
  const operations = operationsOf(compiled.document);
  for (const operation of operations) {
    for (const [status, reason] of frameworkStatuses(operation)) {
      if (operation.statuses.has(status)) continue;
      const entry = missing.get(status) ?? { reason, operations: [] };
      entry.operations.push(operation.operationId);
      missing.set(status, entry);
    }
  }
  for (const [status, { reason, operations: ids }] of [...missing].sort(([a], [b]) => a - b)) {
    io.out(
      `info: ${ids.length} operation(s) do not declare ${status}, which the runtime ` +
        `returns for ${reason}: ${ids.join(", ")}`,
    );
  }
  io.out(
    problems === 0
      ? `doctor: ${operations.length} operations, no problems`
      : `doctor: ${problems} problem(s)`,
  );
  return problems === 0 ? 0 : 1;
}
