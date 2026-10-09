import { relative } from "jsr:@std/path@^1";
import type { OperationModel } from "@hyapi/core/contract";
import { compileProject, readDocument } from "./emit.ts";
import type { Io } from "./run.ts";

/** Statuses the runtime can produce for an operation, with the reason for each. */
function frameworkStatuses(operation: OperationModel): [number, string][] {
  const statuses: [number, string][] = [];
  if (operation.parameters.length > 0 || operation.body !== undefined) {
    statuses.push([400, "invalid input"]);
  }
  if (operation.body !== undefined) {
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
  for (const operation of compiled.model.operations) {
    const declared = new Set(operation.responses.map((response) => response.status));
    for (const [status, reason] of frameworkStatuses(operation)) {
      if (declared.has(status)) continue;
      const entry = missing.get(status) ?? { reason, operations: [] };
      entry.operations.push(operation.operationId);
      missing.set(status, entry);
    }
  }
  for (const [status, { reason, operations }] of [...missing].sort(([a], [b]) => a - b)) {
    io.out(
      `info: ${operations.length} operation(s) do not declare ${status}, which the runtime ` +
        `returns for ${reason}: ${operations.join(", ")}`,
    );
  }
  io.out(
    problems === 0
      ? `doctor: ${compiled.model.operations.length} operations, no problems`
      : `doctor: ${problems} problem(s)`,
  );
  return problems === 0 ? 0 : 1;
}
