// The diagnostics of `createApp`: the problems only it can find, how its checks report them, and
// the error that carries every problem together.
import { describeErrors, type Diagnostic } from "../contract/compile/diagnostics.ts";

/** Stable identifiers for diagnostics that only `createApp` can report. */
export type StartupDiagnosticCode =
  | "invalid-option"
  | "invalid-lifecycle"
  | "unknown-implementation"
  | "duplicate-implementation"
  | "missing-implementation"
  | "missing-handler"
  | "invalid-handler"
  | "unknown-handler"
  | "unknown-timeout-target"
  | "unknown-body-limit-target"
  | "missing-verifier"
  | "invalid-verifier"
  | "unknown-verifier"
  | "document-route-conflict"
  | "format-conflict"
  | "not-implemented";

/** A problem that only `createApp` can find, such as a missing handler. */
export interface StartupDiagnostic extends Omit<Diagnostic, "code"> {
  readonly code: StartupDiagnosticCode;
}

/** Reports a startup error. */
export type StartupReport = (
  code: StartupDiagnosticCode,
  message: string,
  operationId?: string,
) => void;

/** Thrown by `createApp` with every diagnostic that prevents startup. */
export class StartupError extends Error {
  readonly diagnostics: readonly (Diagnostic | StartupDiagnostic)[];

  constructor(diagnostics: readonly (Diagnostic | StartupDiagnostic)[]) {
    const count = diagnostics.filter((d) => d.severity === "error").length;
    super(
      `The application cannot start (${count} error${count === 1 ? "" : "s"}):\n` +
        describeErrors(diagnostics),
    );
    this.name = "StartupError";
    this.diagnostics = diagnostics;
  }
}
