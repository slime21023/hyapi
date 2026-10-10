/** Stable identifiers for contract diagnostics. */
export type DiagnosticCode =
  | "invalid-api"
  | "duplicate-contract"
  | "invalid-security-scheme"
  | "security-schemes-mismatch"
  | "unknown-security-scheme"
  | "undeclared-scope"
  | "empty-security-requirement"
  | "duplicate-operation-id"
  | "duplicate-route"
  | "invalid-method"
  | "invalid-path"
  | "path-parameter-mismatch"
  | "optional-path-parameter"
  | "invalid-parameter-schema"
  | "unsupported-parameter-style"
  | "unknown-style-target"
  | "duplicate-header"
  | "reserved-header"
  | "invalid-body"
  | "body-on-safe-method"
  | "invalid-media-type"
  | "no-responses"
  | "invalid-status"
  | "invalid-response"
  | "body-not-allowed"
  | "unsupported-schema"
  | "unresolved-reference"
  | "invalid-component-name"
  | "duplicate-schema-name"
  | "duplicate-response-name"
  | "unnamed-schema"
  | "unknown-format"
  | "invalid-format"
  | "implicit-public"
  | "unsupported-body-schema"
  | "reserved-schema-name";

/** One problem found in an API's contracts. */
export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly operationId?: string;
  /** A slash-separated path to the offending declaration, such as `getUser/responses/200/body`. */
  readonly location?: string;
}

/** Collects diagnostics; passed explicitly to every normalization step. */
export interface Reporter {
  error(code: DiagnosticCode, message: string, operationId?: string, location?: string): void;
  warn(code: DiagnosticCode, message: string, operationId?: string, location?: string): void;
  readonly diagnostics: readonly Diagnostic[];
  hasErrors(): boolean;
}

/** Creates an empty diagnostic collector. */
export function createReporter(): Reporter {
  const diagnostics: Diagnostic[] = [];
  const report = (
    severity: Diagnostic["severity"],
    code: DiagnosticCode,
    message: string,
    operationId?: string,
    location?: string,
  ) =>
    diagnostics.push(Object.freeze({
      severity,
      code,
      message,
      ...(operationId === undefined ? {} : { operationId }),
      ...(location === undefined ? {} : { location }),
    }));
  return {
    error: (code, message, operationId, location) =>
      report("error", code, message, operationId, location),
    warn: (code, message, operationId, location) =>
      report("warning", code, message, operationId, location),
    diagnostics,
    hasErrors: () => diagnostics.some((d) => d.severity === "error"),
  };
}

/** Formats the error diagnostics of a list as one indented message. */
export function describeErrors(
  diagnostics: readonly (Omit<Diagnostic, "code"> & { readonly code: string })[],
): string {
  return diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => `- [${d.code}]${d.operationId ? ` ${d.operationId}:` : ""} ${d.message}`)
    .join("\n");
}

/** Thrown by `emitOpenApi` when the contracts have errors. */
export class ContractError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const count = diagnostics.filter((d) => d.severity === "error").length;
    super(
      `The contracts have ${count} error${count === 1 ? "" : "s"}:\n${describeErrors(diagnostics)}`,
    );
    this.name = "ContractError";
    this.diagnostics = diagnostics;
  }
}
