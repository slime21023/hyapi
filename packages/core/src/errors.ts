export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  readonly expose: boolean;
  readonly exposeDetails: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: unknown = undefined,
    expose = statusCode < 500,
    exposeDetails = false,
  ) {
    super(message);
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new RangeError("AppError statusCode must be an integer between 400 and 599.");
    }
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
    this.exposeDetails = exposeDetails;
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
    super(
      400,
      "VALIDATION_ERROR",
      "Request validation failed.",
      { source, errors: details },
      true,
      true,
    );
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
