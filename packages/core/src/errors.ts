/** Base error translated to an RFC 7807 HTTP problem response. */
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

/** Reports invalid application setup without disclosing details to HTTP clients. */
export class ConfigurationError extends AppError {
  constructor(message: string, details: unknown = undefined) {
    super(500, "CONFIGURATION_ERROR", message, details, false);
    this.name = "ConfigurationError";
  }
}

/** Reports a resource that does not exist. */
export class NotFoundError extends AppError {
  constructor(message = "The requested resource was not found.") {
    super(404, "NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

/** Reports missing or invalid authentication. */
export class UnauthorizedError extends AppError {
  /** `www-authenticate` value sent with the 401 response, such as `Bearer`. */
  readonly challenge: string | undefined;

  constructor(message = "Authentication is required.", options: { challenge?: string } = {}) {
    super(401, "UNAUTHORIZED", message);
    this.name = "UnauthorizedError";
    this.challenge = options.challenge;
  }
}

/** Reports an authenticated identity that lacks permission. */
export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super(403, "FORBIDDEN", message);
    this.name = "ForbiddenError";
  }
}

/** Reports a request that conflicts with current application state. */
export class ConflictError extends AppError {
  constructor(message: string, details: unknown = undefined) {
    super(409, "CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

/** Reports invalid client input and exposes its validation details. */
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

/** Reports a server response that violates its declared schema. */
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

/** Reports a handler response that violates its declared response contract. */
export class ResponseContractError extends AppError {
  constructor(message: string, details: unknown = undefined) {
    super(500, "RESPONSE_CONTRACT_ERROR", message, details, false);
    this.name = "ResponseContractError";
  }
}
