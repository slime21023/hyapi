// How commands report: the output channels and the format of diagnostics.
import type { Diagnostic } from "@hyapi/core/contract";

/** Output channels, so commands can be tested without a terminal. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

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
