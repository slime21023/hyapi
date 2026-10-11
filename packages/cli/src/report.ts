// How commands report: their output channels. Diagnostics use `formatDiagnostic` from Core.

/** Output channels, so commands can be tested without a terminal. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}
