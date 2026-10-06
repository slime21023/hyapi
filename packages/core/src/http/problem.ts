import type { AppConfig } from "../config.ts";
import { AppError, UnauthorizedError } from "../errors.ts";
import { ScopeClosedError } from "../runtime/scope.ts";

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly requestId: string;
  readonly details?: unknown;
}

/** How an application renders problem responses. */
export interface ProblemOptions {
  /** Base URL for `type`; `about:blank` when omitted. */
  readonly typeBaseUrl?: string | undefined;
  /** Include internal messages and details in every problem (development only). */
  readonly exposeInternal?: boolean;
}

export function problemOptions(config: AppConfig): ProblemOptions {
  return {
    typeBaseUrl: config.problemTypeBaseUrl,
    exposeInternal: config.environment === "development",
  };
}

function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ScopeClosedError) {
    return new AppError(500, error.code, error.message, error.details, false);
  }
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  return new AppError(500, "INTERNAL_ERROR", message, undefined, false);
}

function serializableDetails(details: unknown): unknown {
  try {
    return JSON.stringify(details) === undefined ? undefined : details;
  } catch {
    return undefined;
  }
}

/** Details shown only when internal errors are exposed: the AppError's own, or the thrown value. */
function internalDetails(error: unknown, appError: AppError): unknown {
  if (error instanceof AppError || error instanceof ScopeClosedError) return appError.details;
  if (error instanceof Error) return { name: error.name, stack: error.stack };
  return { thrown: String(error) };
}

/**
 * Builds an RFC 9457 problem. `type` is `about:blank` unless the application configures
 * `problemTypeBaseUrl`, in which case it is `<base>/<lowercase code>`. With `exposeInternal`,
 * hidden messages and details are included for debugging.
 */
export function toProblemDetails(
  error: unknown,
  request: Request,
  requestId: string,
  options: ProblemOptions = {},
): ProblemDetails {
  const appError = asAppError(error);
  const exposeInternal = options.exposeInternal === true;
  const detail = appError.expose || exposeInternal
    ? appError.message
    : "An unexpected error occurred.";
  const result: ProblemDetails = {
    type: options.typeBaseUrl === undefined
      ? "about:blank"
      : `${options.typeBaseUrl}/${appError.code.toLowerCase()}`,
    title: appError.code.replaceAll("_", " "),
    status: appError.statusCode,
    detail,
    instance: new URL(request.url).pathname,
    code: appError.code,
    requestId,
  };
  const exposedDetails = exposeInternal
    ? internalDetails(error, appError)
    : appError.expose && appError.exposeDetails
    ? appError.details
    : undefined;
  if (exposedDetails !== undefined) {
    const details = serializableDetails(exposedDetails);
    if (details !== undefined) return { ...result, details };
  }
  return result;
}

export function errorResponse(
  error: unknown,
  request: Request,
  requestId: string,
  options: ProblemOptions = {},
): Response {
  const problem = toProblemDetails(error, request, requestId, options);
  const headers = new Headers({ "content-type": "application/problem+json" });
  if (error instanceof UnauthorizedError && error.challenge) {
    headers.set("www-authenticate", error.challenge);
  }
  return Response.json(problem, { status: problem.status, headers });
}
