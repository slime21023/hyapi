export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  details?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: unknown = undefined,
    expose = statusCode < 500,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, details: unknown = undefined) {
    super(500, "CONFIGURATION_ERROR", message, details, false);
    this.name = "ConfigurationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "The requested resource was not found.") {
    super(404, "NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication is required.") {
    super(401, "UNAUTHORIZED", message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super(403, "FORBIDDEN", message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details: unknown = undefined) {
    super(409, "CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

export class ValidationError extends AppError {
  constructor(source: string, details: unknown) {
    super(400, "VALIDATION_ERROR", "Request validation failed.", { source, errors: details });
    this.name = "ValidationError";
  }
}

export class ResponseValidationError extends AppError {
  constructor(details: unknown) {
    super(
      500,
      "RESPONSE_VALIDATION_ERROR",
      "Response validation failed.",
      { source: "response", errors: details },
      false,
    );
    this.name = "ResponseValidationError";
  }
}

export class ResponseContractError extends AppError {
  constructor(message: string, details: unknown = undefined) {
    super(500, "RESPONSE_CONTRACT_ERROR", message, details, false);
    this.name = "ResponseContractError";
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  return new AppError(500, "INTERNAL_ERROR", message, undefined, false);
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
  if (appError.expose && appError.details !== undefined) result.details = appError.details;
  return result;
}
