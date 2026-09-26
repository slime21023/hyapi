import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  AppError,
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ResponseContractError,
  ResponseValidationError,
  UnauthorizedError,
  ValidationError,
} from "../../../packages/core/src/errors.ts";
import { toProblemDetails } from "../../../packages/core/src/http/problem.ts";
import { ScopeClosedError } from "../../../packages/core/src/runtime/scope.ts";

Deno.test("AppError rejects invalid HTTP status codes", () => {
  assertThrows(
    () => new AppError(399, "INVALID", "Invalid status"),
    RangeError,
  );
  assertThrows(
    () => new AppError(600, "INVALID", "Invalid status"),
    RangeError,
  );
  assertThrows(
    () => new AppError(400.5, "INVALID", "Invalid status"),
    RangeError,
  );
});

Deno.test("AppError subclasses set appropriate status codes, codes and expose flags", () => {
  const validation = new ValidationError("body", [{ path: "/name", message: "required" }]);
  assertEquals(validation.statusCode, 400);
  assertEquals(validation.code, "VALIDATION_ERROR");
  assertEquals(validation.expose, true);
  assertEquals((validation.details as Record<string, unknown>).errors, [{
    path: "/name",
    message: "required",
  }]);

  const respValidation = new ResponseValidationError([{ path: "/id", message: "required" }]);
  assertEquals(respValidation.statusCode, 500);
  assertEquals(respValidation.code, "RESPONSE_VALIDATION_ERROR");
  assertEquals(respValidation.expose, false);

  const respContract = new ResponseContractError("Response status is not declared.");
  assertEquals(respContract.statusCode, 500);
  assertEquals(respContract.code, "RESPONSE_CONTRACT_ERROR");
  assertEquals(respContract.expose, false);

  const unauth = new UnauthorizedError("Custom unauth message");
  assertEquals(unauth.statusCode, 401);
  assertEquals(unauth.code, "UNAUTHORIZED");
  assertEquals(unauth.expose, true);
  assertEquals(unauth.message, "Custom unauth message");

  const forbidden = new ForbiddenError();
  assertEquals(forbidden.statusCode, 403);
  assertEquals(forbidden.code, "FORBIDDEN");
  assertEquals(forbidden.expose, true);

  const notFound = new NotFoundError("Resource missing");
  assertEquals(notFound.statusCode, 404);
  assertEquals(notFound.code, "NOT_FOUND");
  assertEquals(notFound.expose, true);

  const conflict = new ConflictError("Email already in use");
  assertEquals(conflict.statusCode, 409);
  assertEquals(conflict.code, "CONFLICT");
  assertEquals(conflict.expose, true);

  const config = new ConfigurationError("Invalid option");
  assertEquals(config.statusCode, 500);
  assertEquals(config.code, "CONFIGURATION_ERROR");
  assertEquals(config.expose, false);
});

Deno.test("Problem details expose only explicitly safe details", () => {
  const req = new Request("http://test/v1/users");
  const conflict = new ConflictError("Email already in use", { secret: "hidden" });
  const conflictProblem = toProblemDetails(conflict, req, "req-conflict-1");
  assertEquals(conflictProblem.details, undefined);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const internal = new AppError(400, "SAFE_DETAILS", "Bad input", circular, true, true);
  const internalProblem = toProblemDetails(internal, req, "req-circular-1");
  assertEquals(internalProblem.details, undefined);
});

Deno.test("toProblemDetails formats AppErrors correctly with RFC 7807 schema", () => {
  const req = new Request("http://test/v1/users/999");
  const notFound = new NotFoundError("User 999 not found.");
  const problem = toProblemDetails(notFound, req, "req-uuid-123");

  assertEquals(problem.status, 404);
  assertEquals(problem.title, "NOT FOUND");
  assertEquals(problem.detail, "User 999 not found.");
  assertEquals(problem.code, "NOT_FOUND");
  assertEquals(problem.instance, "/v1/users/999");
  assertEquals(problem.requestId, "req-uuid-123");
  assertStringIncludes(problem.type, "https://hyapi.dev/problems/not_found");
});

Deno.test("toProblemDetails includes details for ValidationError", () => {
  const req = new Request("http://test/v1/users");
  const validation = new ValidationError("body", [
    { path: "/email", message: "must match format email" },
    { path: "/age", message: "must be integer" },
  ]);
  const problem = toProblemDetails(validation, req, "req-val-1");

  assertEquals(problem.status, 400);
  assertEquals(problem.code, "VALIDATION_ERROR");
  const details = problem.details as { source: string; errors: unknown[] };
  assertEquals(details.errors.length, 2);
});

Deno.test("toProblemDetails sanitizes unexposed internal server errors", () => {
  const req = new Request("http://test/v1/sensitive");
  const internalError = new Error("Database connection pool password leaked in error");
  const problem = toProblemDetails(internalError, req, "req-err-1");

  assertEquals(problem.status, 500);
  assertEquals(problem.code, "INTERNAL_ERROR");
  assertEquals(problem.title, "INTERNAL ERROR");
  // Should NOT leak internal error message
  assertEquals(problem.detail, "An unexpected error occurred.");
  assertEquals(problem.requestId, "req-err-1");
});

Deno.test("toProblemDetails translates runtime scope errors without giving runtime HTTP details", () => {
  const req = new Request("http://test/v1/users");
  const problem = toProblemDetails(new ScopeClosedError(), req, "req-scope-1");

  assertEquals(problem.status, 500);
  assertEquals(problem.code, "SCOPE_CLOSED");
  assertEquals(problem.detail, "An unexpected error occurred.");
});

Deno.test("toProblemDetails handles non-Error thrown values", () => {
  const req = new Request("http://test/v1/weird");
  const stringProblem = toProblemDetails("Something went wrong string", req, "req-str-1");
  assertEquals(stringProblem.status, 500);
  assertEquals(stringProblem.code, "INTERNAL_ERROR");

  const objProblem = toProblemDetails({ foo: "bar" }, req, "req-obj-1");
  assertEquals(objProblem.status, 500);
  assertEquals(objProblem.code, "INTERNAL_ERROR");
});
