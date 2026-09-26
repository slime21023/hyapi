import { AppError } from "../errors.ts";

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

export function toProblemDetails(
  error: unknown,
  request: Request,
  requestId: string,
): ProblemDetails {
  const appError = asAppError(error);
  const detail = appError.expose ? appError.message : "An unexpected error occurred.";
  const result: ProblemDetails = {
    type: `https://hyapi.dev/problems/${appError.code.toLowerCase()}`,
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
