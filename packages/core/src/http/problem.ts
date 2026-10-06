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

/**
 * Builds an RFC 9457 problem. `type` is `about:blank` unless the application configures
 * `problemTypeBaseUrl`, in which case it is `<base>/<lowercase code>`.
 */
export function toProblemDetails(
  error: unknown,
  request: Request,
  requestId: string,
  typeBaseUrl?: string,
): ProblemDetails {
  const appError = asAppError(error);
  const detail = appError.expose ? appError.message : "An unexpected error occurred.";
  const result: ProblemDetails = {
    type: typeBaseUrl === undefined
      ? "about:blank"
      : `${typeBaseUrl}/${appError.code.toLowerCase()}`,
    title: appError.code.replaceAll("_", " "),
    status: appError.statusCode,
    detail,
    instance: new URL(request.url).pathname,
    code: appError.code,
    requestId,
  };
  if (appError.expose && appError.exposeDetails && appError.details !== undefined) {
    const details = serializableDetails(appError.details);
    if (details !== undefined) return { ...result, details };
  }
  return result;
}

export function errorResponse(
  error: unknown,
  request: Request,
  requestId: string,
  typeBaseUrl?: string,
): Response {
  const problem = toProblemDetails(error, request, requestId, typeBaseUrl);
  const headers = new Headers({ "content-type": "application/problem+json" });
  if (error instanceof UnauthorizedError && error.challenge) {
    headers.set("www-authenticate", error.challenge);
  }
  return Response.json(problem, { status: problem.status, headers });
}
