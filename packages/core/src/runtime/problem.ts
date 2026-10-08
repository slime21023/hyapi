import type { Static } from "typebox";
import type { Problem } from "../contract/schema.ts";
import { reasonPhrase } from "../contract/reason.ts";

/** Stable codes for problems that HyAPI itself produces. */
export type ProblemCode =
  | "VALIDATION_FAILED"
  | "MALFORMED_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_IMPLEMENTED"
  | "REQUEST_TIMEOUT"
  | "RESPONSE_CONTRACT_VIOLATION"
  | "INTERNAL_ERROR";

/** One reason a request or response did not match its contract. */
export interface Violation {
  /** Where the value came from: `path`, `query`, `header`, `cookie`, `body`, or `response`. */
  readonly location: string;
  /** A JSON Pointer into that value; empty for the value itself. */
  readonly pointer: string;
  readonly message: string;
}

/** A problem details value (RFC 9457). */
export type ProblemValue = Static<typeof Problem>;

/**
 * Builds a problem details body for a declared error response. The runtime fills in `status` from
 * the returned status, so it is not passed here.
 *
 * @example
 * ```ts
 * return { status: 404, body: problem({ title: "User not found", detail: `No user ${id}` }) };
 * ```
 */
export function problem(
  value: Omit<ProblemValue, "status"> & { readonly title: string },
): ProblemValue {
  return { ...value };
}

/**
 * An error for cross-cutting or unexpected failures. Declared outcomes should be returned instead.
 * The runtime answers with a problem response using this status.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    options: {
      readonly title?: string;
      readonly detail?: string;
      readonly code?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(options.title ?? reasonPhrase(status), { cause: options.cause });
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`HttpError status must be an integer from 400 to 599, got ${status}`);
    }
    this.name = "HttpError";
    this.status = status;
    this.code = options.code ?? "HTTP_ERROR";
    this.detail = options.detail;
    this.headers = options.headers ?? {};
  }
}

/** Serializes a problem response. Never throws. */
export function problemResponse(
  status: number,
  code: string,
  options: {
    readonly title?: string;
    readonly detail?: string;
    readonly violations?: readonly Violation[];
    readonly headers?: Readonly<Record<string, string>>;
    readonly debug?: unknown;
  } = {},
): Response {
  const body: Record<string, unknown> = {
    type: "about:blank",
    title: options.title ?? reasonPhrase(status),
    status,
    code,
  };
  if (options.detail !== undefined) body.detail = options.detail;
  if (options.violations !== undefined) body.violations = options.violations;
  if (options.debug !== undefined) body.debug = options.debug;
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    text = JSON.stringify({ type: "about:blank", title: reasonPhrase(500), status: 500, code });
    status = 500;
  }
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/problem+json");
  return new Response(text, { status, headers });
}

/** Describes an unknown thrown value for development diagnostics. */
export function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: typeof error, message: String(error) };
}
