import Type from "typebox";
import type { OperationModel, ParameterLocation, ResponseModel } from "../contract/model.ts";
import { describeError, HttpError, problemResponse, type Violation } from "./problem.ts";
import type { Emit } from "./events.ts";
import type { SecurityEvaluator } from "./security.ts";
import type { Validator, ValidatorFactory } from "./validation.ts";
import { encodeBody, INPUT_KEYS, isJsonMediaType, readBody, readParameters } from "./wire.ts";

/** How responses that do not match their schema are handled. */
export type ResponseValidation = "off" | "log" | "enforce";

export interface PipelineSettings {
  readonly development: boolean;
  readonly responseValidation: ResponseValidation;
  readonly bodyLimitBytes: number;
  readonly emit: Emit;
}

/** The response, and the error a handler or verifier threw when it became a 500. */
export interface Outcome {
  readonly response: Response;
  readonly error?: unknown;
}

// deno-lint-ignore no-explicit-any
type AnyHandler = (input: any, ctx: any) => unknown;

interface LocationPlan {
  readonly location: ParameterLocation;
  readonly key: "params" | "query" | "headers" | "cookies";
  readonly validator: Validator;
}

/** Everything prepared at startup to execute one operation. */
export interface OperationPlan {
  readonly operation: OperationModel;
  readonly handler: AnyHandler | undefined;
  /** The request timeout of this operation. */
  readonly timeoutMs: number;
  readonly locations: readonly LocationPlan[];
  readonly body: Validator | undefined;
  readonly responses: ReadonlyMap<number, { model: ResponseModel; body: Validator | undefined }>;
}

const LOCATION_ORDER: readonly ParameterLocation[] = ["path", "query", "header", "cookie"];

/** Prepares the validators and lookups of one operation. */
export function planOperation(
  operation: OperationModel,
  handler: AnyHandler | undefined,
  timeoutMs: number,
  validators: ValidatorFactory,
): OperationPlan {
  const locations: LocationPlan[] = [];
  for (const location of LOCATION_ORDER) {
    const parameters = operation.parameters.filter((parameter) => parameter.in === location);
    if (parameters.length === 0) continue;
    // Rebuild the location object from the model; the runtime never reads raw declarations.
    const schema = Type.Object(
      Object.fromEntries(
        parameters.map((p) => [p.name, p.required ? p.schema : Type.Optional(p.schema)]),
      ),
    );
    locations.push({ location, key: INPUT_KEYS[location], validator: validators(schema) });
  }
  const responses = new Map(
    operation.responses.map((response) => [
      response.status,
      { model: response, body: response.body ? validators(response.body.schema) : undefined },
    ]),
  );
  return {
    operation,
    handler,
    timeoutMs,
    locations,
    body: operation.body ? validators(operation.body.schema) : undefined,
    responses,
  };
}

function validationFailed(violations: readonly Violation[]): Response {
  return problemResponse(400, "VALIDATION_FAILED", {
    detail: "The request does not match the operation's contract.",
    violations,
  });
}

/** Runs one matched request through the operation's contract. */
export async function execute(
  plan: OperationPlan,
  request: Request,
  url: URL,
  params: Readonly<Record<string, string>>,
  settings: PipelineSettings,
  security: SecurityEvaluator,
  shutdown: AbortSignal,
): Promise<Outcome> {
  const { operation } = plan;
  // One signal for the whole request: client disconnect, the request timeout, and forced
  // shutdown. The timeout covers verifiers, body reading, and the handler.
  const timeout = new AbortController();
  const signal = AbortSignal.any([request.signal, timeout.signal, shutdown]);
  const timer = setTimeout(
    () => timeout.abort(new DOMException("The request timed out.", "TimeoutError")),
    plan.timeoutMs,
  );
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  // The race may already be over when the client disconnects; never leave the rejection unhandled.
  aborted.catch(() => {});
  const bounded = <T>(work: Promise<T> | T): Promise<T> =>
    Promise.race([Promise.resolve(work), aborted]);

  try {
    return { response: await run() };
  } catch (error) {
    if (timeout.signal.aborted && error === timeout.signal.reason) {
      return {
        response: problemResponse(503, "REQUEST_TIMEOUT", {
          detail: `The request did not complete within ${plan.timeoutMs} ms.`,
        }),
      };
    }
    if (shutdown.aborted && error === shutdown.reason) {
      return {
        response: problemResponse(503, "SHUTTING_DOWN", {
          detail: "The server is shutting down.",
          headers: { connection: "close" },
        }),
      };
    }
    return thrown(error, operation, settings);
  } finally {
    clearTimeout(timer);
  }

  async function run(): Promise<Response> {
    // Security runs first, so unauthenticated callers learn nothing about the schemas.
    let identities: Readonly<Record<string, unknown>> | undefined;
    if (operation.security.length > 0) {
      const result = await bounded(
        security(operation.security, request, url, {
          signal,
          request,
          operationId: operation.operationId,
        }),
      );
      if (result.kind === "denied") return result.response;
      identities = result.security;
    }

    // Parameters: read, apply defaults, coerce, and validate every location before the body.
    const input: Record<string, unknown> = {};
    const violations: Violation[] = [];
    for (const { location, key, validator } of plan.locations) {
      let value: unknown = readParameters(location, operation.parameters, {
        params,
        url,
        headers: request.headers,
      });
      if (location !== "path") value = validator.defaults(value);
      value = validator.convert(value);
      violations.push(...validator.check(value, location));
      input[key] = value;
    }
    if (violations.length > 0) return validationFailed(violations);

    // Body.
    if (operation.body !== undefined) {
      const result = await bounded(readBody(request, operation.body, settings.bodyLimitBytes));
      switch (result.kind) {
        case "too-large":
          return problemResponse(413, "PAYLOAD_TOO_LARGE", {
            detail: `The request body exceeds ${settings.bodyLimitBytes} bytes.`,
          });
        case "unsupported-media-type":
          return problemResponse(415, "UNSUPPORTED_MEDIA_TYPE", {
            detail: `Expected ${operation.body.mediaType}, got ${
              result.mediaType ?? "no content type"
            }.`,
            headers: { "accept-post": operation.body.mediaType },
          });
        case "malformed":
          return problemResponse(400, "MALFORMED_REQUEST", { detail: result.detail });
        case "absent":
          if (operation.body.required) {
            return validationFailed([{
              location: "body",
              pointer: "",
              message: "a request body is required",
            }]);
          }
          break;
        case "ok": {
          if (!(result.value instanceof Uint8Array)) {
            const bodyViolations = plan.body!.check(result.value, "body");
            if (bodyViolations.length > 0) return validationFailed(bodyViolations);
          }
          input.body = result.value;
        }
      }
    }

    if (plan.handler === undefined) {
      return problemResponse(501, "NOT_IMPLEMENTED", {
        detail: `Operation '${operation.operationId}' is not implemented yet.`,
      });
    }
    const ctx = { signal, request, operationId: operation.operationId, security: identities };
    return respond(plan, await bounded(plan.handler(input, ctx)), settings);
  }
}

function thrown(error: unknown, operation: OperationModel, settings: PipelineSettings): Outcome {
  if (error instanceof HttpError) {
    return {
      response: problemResponse(error.status, error.code, {
        title: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        headers: error.headers,
      }),
    };
  }
  const response = settings.development
    ? problemResponse(500, "INTERNAL_ERROR", {
      detail: `Operation '${operation.operationId}' threw an error.`,
      debug: describeError(error),
    })
    : problemResponse(500, "INTERNAL_ERROR");
  return { response, error };
}

function lookupHeader(headers: unknown, name: string): unknown {
  if (typeof headers !== "object" || headers === null) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

/** Applies the response policy and serializes a handler result. */
function respond(plan: OperationPlan, result: unknown, settings: PipelineSettings): Response {
  const { operation } = plan;
  const violations: Violation[] = [];
  const contractViolation = (status: number, fallback: () => Response): Response => {
    settings.emit({
      type: "response.violation",
      operationId: operation.operationId,
      status,
      violations: [...violations],
    });
    if (settings.responseValidation === "enforce") {
      return problemResponse(500, "RESPONSE_CONTRACT_VIOLATION", {
        detail:
          `Operation '${operation.operationId}' returned a response that its contract does not allow.`,
        ...(settings.development ? { violations } : {}),
      });
    }
    return fallback();
  };

  if (result instanceof Response) {
    if (!plan.responses.has(result.status)) {
      violations.push({
        location: "response",
        pointer: "",
        message: `status ${result.status} is not declared`,
      });
      return contractViolation(result.status, () => result);
    }
    return result;
  }
  if (
    typeof result !== "object" || result === null ||
    typeof (result as { status?: unknown }).status !== "number"
  ) {
    return problemResponse(500, "RESPONSE_CONTRACT_VIOLATION", {
      detail:
        `Operation '${operation.operationId}' returned a value that is not a result object or Response.`,
    });
  }
  const { status, body, headers: given } = result as {
    status: number;
    body?: unknown;
    headers?: unknown;
  };
  const declared = plan.responses.get(status);
  const headers = new Headers();
  if (typeof given === "object" && given !== null) {
    for (const [name, value] of Object.entries(given)) {
      if (value !== undefined) {
        headers.set(name, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
  }

  if (declared === undefined) {
    violations.push({
      location: "response",
      pointer: "",
      message: `status ${status} is not declared`,
    });
    return contractViolation(status, () => {
      if (body === undefined) return new Response(null, { status, headers });
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(body), { status, headers });
    });
  }

  for (const header of declared.model.headers) {
    if (header.required && lookupHeader(given, header.name) === undefined) {
      violations.push({
        location: "response",
        pointer: `/headers/${header.name}`,
        message: "required header is missing",
      });
    }
  }

  let payload: BodyInit | null = null;
  if (declared.model.body === undefined) {
    if (body !== undefined) {
      violations.push({
        location: "response",
        pointer: "/body",
        message: `status ${status} declares no body`,
      });
    }
  } else {
    const { mediaType } = declared.model.body;
    let value = body;
    if (
      mediaType === "application/problem+json" && typeof value === "object" && value !== null &&
      !("status" in value)
    ) {
      value = { ...value, status };
    }
    if (isJsonMediaType(mediaType)) {
      const cleaned = declared.body!.clean(value, settings.development);
      value = cleaned.value;
      if (settings.development && cleaned.removed.length > 0) {
        settings.emit({
          type: "response.stripped",
          operationId: operation.operationId,
          status,
          removed: cleaned.removed,
        });
      }
    }
    if (settings.responseValidation !== "off" && !(value instanceof Uint8Array)) {
      violations.push(
        ...declared.body!.check(value, "response").map((v) => ({
          ...v,
          pointer: `/body${v.pointer}`,
        })),
      );
    }
    payload = encodeBody(value, mediaType);
    headers.set("content-type", mediaType);
  }

  const send = () => new Response(payload, { status, headers });
  return violations.length > 0 ? contractViolation(status, send) : send();
}
