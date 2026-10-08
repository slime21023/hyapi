import type { Diagnostic } from "@hyapi/core/contract";

/** Formats one diagnostic as `error [code] operationId (location): message`. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where = [
    diagnostic.operationId,
    diagnostic.location === undefined ? undefined : `(${diagnostic.location})`,
  ].filter(Boolean).join(" ");
  return `${diagnostic.severity} [${diagnostic.code}]${
    where ? ` ${where}` : ""
  }: ${diagnostic.message}`;
}
