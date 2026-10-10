import { reasonPhrase } from "../base/http.ts";

/** One reason a request or response did not match its contract. */
export interface Violation {
  /** Where the value came from: `path`, `query`, `header`, `cookie`, `body`, or `response`. */
  readonly location: string;
  /** A JSON Pointer into that value; empty for the value itself. */
  readonly pointer: string;
  readonly message: string;
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

/**
 * Builds an RFC 9457 problem response in the same shape that HyAPI uses for its own errors:
 * `type: "about:blank"`, the reason phrase as `title`, `status`, and a stable `code`. Never
 * throws. Outer `fetch` wrappers (plugins) use it to answer consistently.
 */
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

/** A thrown value as plain data, for events and development diagnostics. */
export interface ErrorInfo {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** The error's `cause`, followed to a depth of three. */
  readonly cause?: ErrorInfo;
}

/** Describes an unknown thrown value, with its stack and causes. */
export function describeError(error: unknown, depth = 3): ErrorInfo {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
  const cause = error.cause !== undefined && depth > 1
    ? describeError(error.cause, depth - 1)
    : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(cause === undefined ? {} : { cause }),
  };
}
