import Type from "typebox";
import type { OperationModel, ParameterLocation, ResponseModel } from "../contract/model.ts";
import { cloneSchema } from "../contract/snapshot.ts";
import { isJsonMediaType } from "../contract/media.ts";
import { encodeBody, readBody } from "./body.ts";
import { readParameters } from "./params.ts";
import { describeError, HttpError, problemResponse, type Violation } from "./problem.ts";
import type { Denial, SecurityEvaluator } from "./security.ts";
import type { Validator, ValidatorFactory } from "./validation.ts";

/** How responses that do not match their schema are handled. */
export type ResponseValidation = "off" | "log" | "enforce";

export interface PipelineSettings {
  readonly development: boolean;
  readonly responseValidation: ResponseValidation;
  readonly bodyLimitBytes: number;
}

/**
 * The response of one request and the facts about how it was produced. The application turns
 * the facts into events (ADR 0003 §9); the request flow emits nothing itself.
 */
export interface Outcome {
  readonly response: Response;
  /** The problem `code` when HyAPI or an `HttpError` produced the response. */
  readonly code?: string;
  /** The error a handler or verifier threw when it became a 500. */
  readonly error?: unknown;
  /** Why security denied the request. */
  readonly denial?: Denial;
  /** The handler's response did not match its contract. */
  readonly violation?: { readonly status: number; readonly violations: readonly Violation[] };
  /** Development only: undeclared response fields that were removed. */
  readonly stripped?: { readonly status: number; readonly removed: readonly string[] };
  /**
   * The body is produced while it is sent (a raw `Response` from the handler, or a stream), so the
   * request stays in flight until the body ends.
   */
  readonly streaming?: boolean;
}

// deno-lint-ignore no-explicit-any
type AnyHandler = (input: any, ctx: any) => unknown;

/** The input keys of a handler per parameter location, as in RFC 0001. */
const INPUT_KEYS: Readonly<Record<ParameterLocation, "params" | "query" | "headers" | "cookies">> =
  {
    path: "params",
    query: "query",
    header: "headers",
    cookie: "cookies",
  };

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
  readonly responses: ReadonlyMap<number, ResponsePlan>;
}

interface ResponsePlan {
  readonly model: ResponseModel;
  readonly body: Validator | undefined;
  /** One validator per declared header, by header name. */
  readonly headers: ReadonlyMap<string, Validator>;
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
    // TypeBox's Optional redefines markers, so it works on a writable copy of the frozen model.
    const schema = Type.Object(
      Object.fromEntries(
        parameters.map((p) => {
          const copy = cloneSchema(p.schema);
          return [p.name, p.required ? copy : Type.Optional(copy)];
        }),
      ),
    );
    locations.push({ location, key: INPUT_KEYS[location], validator: validators(schema) });
  }
  const responses = new Map(
    operation.responses.map((response): [number, ResponsePlan] => [
      response.status,
      {
        model: response,
        body: response.body ? validators(response.body.schema) : undefined,
        headers: new Map(
          response.headers.map((header) => [header.name, validators(header.schema)]),
        ),
      },
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

/** A problem response that HyAPI produces, with its code recorded in the outcome. */
function fail(
  status: number,
  code: string,
  options: Parameters<typeof problemResponse>[2] = {},
): Outcome {
  return { response: problemResponse(status, code, options), code };
}

function validationFailed(violations: readonly Violation[]): Outcome {
  return fail(400, "VALIDATION_FAILED", {
    detail: "The request does not match the operation's contract.",
    violations,
  });
}

function denied(denial: Denial): Outcome {
  const headers = denial.challenges.length === 0
    ? undefined
    : { "www-authenticate": denial.challenges.join(", ") };
  const outcome = denial.status === 403
    ? fail(403, "FORBIDDEN", {
      detail: "The credentials do not grant the scopes this operation requires.",
      ...(headers === undefined ? {} : { headers }),
    })
    : fail(401, "UNAUTHORIZED", {
      detail: "The request lacks valid credentials for this operation.",
      ...(headers === undefined ? {} : { headers }),
    });
  return { ...outcome, denial };
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
    return await run();
  } catch (error) {
    if (timeout.signal.aborted && error === timeout.signal.reason) {
      return fail(503, "REQUEST_TIMEOUT", {
        detail: `The request did not complete within ${plan.timeoutMs} ms.`,
      });
    }
    if (shutdown.aborted && error === shutdown.reason) {
      return fail(503, "SHUTTING_DOWN", {
        detail: "The server is shutting down.",
        headers: { connection: "close" },
      });
    }
    return thrown(error, operation, settings);
  } finally {
    clearTimeout(timer);
  }

  async function run(): Promise<Outcome> {
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
      if (result.kind === "denied") return denied(result.denial);
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
      const result = await bounded(
        readBody(request, operation.body, settings.bodyLimitBytes, signal),
      );
      switch (result.kind) {
        case "too-large":
          return fail(413, "PAYLOAD_TOO_LARGE", {
            detail: `The request body exceeds ${settings.bodyLimitBytes} bytes.`,
          });
        case "unsupported-media-type":
          return fail(415, "UNSUPPORTED_MEDIA_TYPE", {
            detail: `Expected ${operation.body.mediaType}, got ${
              result.mediaType ?? "no content type"
            }.`,
            headers: { "accept-post": operation.body.mediaType },
          });
        case "malformed":
          return fail(400, "MALFORMED_REQUEST", { detail: result.detail });
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
      return fail(501, "NOT_IMPLEMENTED", {
        detail: `Operation '${operation.operationId}' is not implemented yet.`,
      });
    }
    const ctx = { signal, request, operationId: operation.operationId, security: identities };
    return respond(plan, await bounded(plan.handler(input, ctx)), settings);
  }
}

function thrown(error: unknown, operation: OperationModel, settings: PipelineSettings): Outcome {
  if (error instanceof HttpError) {
    return fail(error.status, error.code, {
      title: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      headers: error.headers,
    });
  }
  const outcome = settings.development
    ? fail(500, "INTERNAL_ERROR", {
      detail: `Operation '${operation.operationId}' threw an error.`,
      debug: describeError(error),
    })
    : fail(500, "INTERNAL_ERROR");
  return { ...outcome, error };
}

function lookupHeader(headers: unknown, name: string): unknown {
  if (typeof headers !== "object" || headers === null) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

/**
 * The outcome of a contract violation for a raw `Response`: when it is still sent (policy `log`),
 * its body streams; when it is replaced (policy `enforce`), its body is cancelled.
 */
function withBody(outcome: Outcome, original: Response): Outcome {
  if (outcome.response === original) return { ...outcome, streaming: original.body !== null };
  void original.body?.cancel().catch(() => {});
  return outcome;
}

/** Applies the response policy and serializes a handler result. */
function respond(plan: OperationPlan, result: unknown, settings: PipelineSettings): Outcome {
  const { operation } = plan;
  // With "off", no response check runs and no violation is reported (RFC 0001 A26).
  const checking = settings.responseValidation !== "off";
  const violations: Violation[] = [];
  let stripped: Outcome["stripped"];
  const contractViolation = (status: number, fallback: () => Response): Outcome => {
    const violation = { status, violations: [...violations] };
    if (settings.responseValidation === "enforce") {
      return {
        ...fail(500, "RESPONSE_CONTRACT_VIOLATION", {
          detail:
            `Operation '${operation.operationId}' returned a response that its contract does not allow.`,
          ...(settings.development ? { violations } : {}),
        }),
        violation,
        ...(stripped === undefined ? {} : { stripped }),
      };
    }
    return {
      response: fallback(),
      violation,
      ...(stripped === undefined ? {} : { stripped }),
    };
  };

  if (result instanceof Response) {
    const streaming = result.body !== null;
    if (checking && !plan.responses.has(result.status)) {
      violations.push({
        location: "response",
        pointer: "",
        message: `status ${result.status} is not declared`,
      });
      return withBody(contractViolation(result.status, () => result), result);
    }
    return { response: result, streaming };
  }
  if (
    typeof result !== "object" || result === null ||
    typeof (result as { status?: unknown }).status !== "number"
  ) {
    return fail(500, "RESPONSE_CONTRACT_VIOLATION", {
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
    const undeclared = () => {
      if (body === undefined) return new Response(null, { status, headers });
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(body), { status, headers });
    };
    if (!checking) return { response: undeclared() };
    violations.push({
      location: "response",
      pointer: "",
      message: `status ${status} is not declared`,
    });
    return contractViolation(status, undeclared);
  }

  if (checking) {
    for (const header of declared.model.headers) {
      const value = lookupHeader(given, header.name);
      const pointer = `/headers/${header.name}`;
      if (value === undefined) {
        if (header.required) {
          violations.push({ location: "response", pointer, message: "required header is missing" });
        }
        continue;
      }
      violations.push(
        ...declared.headers.get(header.name)!.check(value, "response").map((v) => ({
          ...v,
          pointer: `${pointer}${v.pointer}`,
        })),
      );
    }
  }

  let payload: BodyInit | null = null;
  let streaming = false;
  if (declared.model.body === undefined) {
    if (checking && body !== undefined) {
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
        stripped = { status, removed: cleaned.removed };
      }
    }
    if (checking && !(value instanceof Uint8Array) && !(value instanceof ReadableStream)) {
      violations.push(
        ...declared.body!.check(value, "response").map((v) => ({
          ...v,
          pointer: `/body${v.pointer}`,
        })),
      );
    }
    payload = encodeBody(value, mediaType);
    streaming = payload instanceof ReadableStream;
    headers.set("content-type", mediaType);
  }

  const send = () => new Response(payload, { status, headers });
  if (violations.length > 0) {
    const outcome = contractViolation(status, send);
    if (outcome.code !== undefined && payload instanceof ReadableStream) {
      void payload.cancel().catch(() => {});
      return outcome;
    }
    return streaming ? { ...outcome, streaming } : outcome;
  }
  return {
    response: send(),
    ...(stripped === undefined ? {} : { stripped }),
    ...(streaming ? { streaming } : {}),
  };
}
