// The entry point: validates both documents, compares them, and orders the changes.
import type { Change, DiffResult } from "./change.ts";
import { type Json, validate } from "./document.ts";
import { compareOperations } from "./operations.ts";

/**
 * Compares two OpenAPI 3.1 documents and classifies every change by its effect on consumers.
 *
 * Changes are direction-aware. For what consumers send (parameters, request bodies), a stricter
 * contract is breaking. For what they receive (responses), a looser contract is breaking.
 * Operations are matched by method and path template, so renaming a path parameter is not a
 * change.
 */
export function diffOpenApi(base: unknown, head: unknown): DiffResult {
  const errors = [...validate(base, "base"), ...validate(head, "head")];
  if (errors.length > 0) return { ok: false, errors };
  const changes: Change[] = [];
  compareOperations(base as Json, head as Json, changes);
  changes.sort((a, z) =>
    (a.severity === z.severity ? 0 : a.severity === "breaking" ? -1 : 1) ||
    (a.operation ?? "").localeCompare(z.operation ?? "") ||
    a.location.localeCompare(z.location)
  );
  return { ok: true, changes, breaking: changes.filter((c) => c.severity === "breaking").length };
}
