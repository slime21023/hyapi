import { relative } from "jsr:@std/path@^1";
import type { OpenApiDocument } from "@hyapi/core/openapi";
import { type Compiled, compileProject, labelFor, readDocument } from "./emit.ts";
import type { Io } from "./report.ts";

const METHODS = ["get", "head", "post", "put", "patch", "delete", "options", "trace"];

interface DocumentOperation {
  readonly operationId: string;
  /** `METHOD /path`, as declared. */
  readonly route: string;
  readonly hasParameters: boolean;
  readonly hasBody: boolean;
  readonly statuses: ReadonlySet<number>;
}

/** The operations of one path item. */
function pathOperations(path: string, item: Record<string, unknown>): DocumentOperation[] {
  return METHODS.filter((method) => item[method] !== undefined).map((method) => {
    const operation = item[method] as Record<string, unknown>;
    return {
      operationId: String(operation.operationId),
      route: `${method.toUpperCase()} ${path}`,
      hasParameters: Array.isArray(operation.parameters) && operation.parameters.length > 0,
      hasBody: operation.requestBody !== undefined,
      statuses: new Set(Object.keys(operation.responses ?? {}).map(Number)),
    };
  });
}

/** The operations of an emitted document, in document order. */
function operationsOf(document: OpenApiDocument): DocumentOperation[] {
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(paths).flatMap(([path, item]) => pathOperations(path, item));
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

/** Reports committed files that are missing or stale; returns how many. */
async function checkFiles(compiled: Compiled, cwd: string, label: string, io: Io) {
  let problems = 0;
  for (const file of compiled.files) {
    const shown = relative(cwd, file.path) || file.path;
    const current = await readDocument(file.path);
    if (current === file.text) continue;
    problems++;
    io.err(
      current === undefined
        ? `${label}error: ${shown} does not exist; run hyapi emit`
        : `${label}error: ${shown} is out of date; run hyapi emit`,
    );
  }
  return problems;
}

/** Lists the framework statuses that the document's operations do not declare. */
function reportUndeclared(operations: readonly DocumentOperation[], label: string, io: Io) {
  const missing = new Map<number, { reason: string; operations: string[] }>();
  for (const operation of operations) {
    const undeclared = frameworkStatuses(operation).filter(([status]) =>
      !operation.statuses.has(status)
    );
    for (const [status, reason] of undeclared) {
      const entry = missing.get(status) ?? { reason, operations: [] };
      entry.operations.push(operation.operationId);
      missing.set(status, entry);
    }
  }
  for (const [status, { reason, operations: ids }] of [...missing].sort(([a], [b]) => a - b)) {
    io.out(
      `${label}info: ${ids.length} operation(s) do not declare ${status}, which the runtime ` +
        `returns for ${reason}: ${ids.join(", ")}`,
    );
  }
}

/**
 * Reports an `operationId` that names different routes in different documents. Documents of one
 * application share their contracts, so they must agree.
 */
function checkConsistency(documents: readonly Compiled[], io: Io): number {
  const operations = documents.flatMap((compiled) =>
    operationsOf(compiled.document).map((operation) => ({ ...operation, in: compiled.target.name }))
  );
  const routes = new Map<string, { route: string; in: string }>();
  let problems = 0;
  for (const operation of operations) {
    const seen = routes.get(operation.operationId);
    if (seen === undefined) {
      routes.set(operation.operationId, operation);
      continue;
    }
    if (seen.route === operation.route) continue;
    problems++;
    io.err(
      `error: operationId '${operation.operationId}' is ${seen.route} in '${seen.in}' but ` +
        `${operation.route} in '${operation.in}'`,
    );
  }
  return problems;
}

/**
 * `hyapi doctor`: checks the contracts and the committed documents without starting a server,
 * checks that several documents agree, and lists framework responses that the contracts do not
 * document.
 */
export async function doctorCommand(
  cwd: string,
  flags: { readonly api?: string; readonly out?: string; readonly document?: string },
  io: Io,
): Promise<number> {
  const compiled = await compileProject(cwd, flags, io);
  if (compiled === undefined) {
    io.err("doctor: the contracts have errors");
    return 1;
  }
  const label = labelFor(compiled.map((document) => document.target));
  let problems = 0;
  const operationIds = new Set<string>();
  for (const document of compiled) {
    problems += await checkFiles(document, cwd, label(document.target), io);
    const operations = operationsOf(document.document);
    reportUndeclared(operations, label(document.target), io);
    for (const operation of operations) operationIds.add(operation.operationId);
  }
  problems += checkConsistency(compiled, io);
  const documents = compiled.length > 1 ? `${compiled.length} documents, ` : "";
  io.out(
    problems === 0
      ? `doctor: ${documents}${operationIds.size} operations, no problems`
      : `doctor: ${problems} problem(s)`,
  );
  return problems === 0 ? 0 : 1;
}
