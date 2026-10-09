import Type from "typebox";
import type {
  BodyModel,
  OperationModel,
  ParameterLocation,
  ResponseModel,
} from "../contract/model.ts";
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

/** One request in flight: what its steps read, and how they stay within its deadline. */
interface RequestScope {
  readonly plan: OperationPlan;
  readonly request: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly settings: PipelineSettings;
  /** Aborts on client disconnect, the request timeout, and forced shutdown. */
  readonly signal: AbortSignal;
  /** Races work against `signal`, rejecting with its reason. */
  readonly bounded: <T>(work: Promise<T> | T) => Promise<T>;
}

/** A promise that rejects when `signal` aborts. Its rejection is always handled. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  // The race may already be over when the client disconnects; never leave the rejection unhandled.
  aborted.catch(() => {});
  return aborted;
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
  // One signal for the whole request: client disconnect, the request timeout, and forced
  // shutdown. The timeout covers verifiers, body reading, and the handler.
  const timeout = new AbortController();
  const signal = AbortSignal.any([request.signal, timeout.signal, shutdown]);
  const timer = setTimeout(
    () => timeout.abort(new DOMException("The request timed out.", "TimeoutError")),
    plan.timeoutMs,
  );
  const aborted = rejectOnAbort(signal);
  const scope: RequestScope = {
    plan,
    request,
    url,
    params,
    settings,
    signal,
    bounded: (work) => Promise.race([Promise.resolve(work), aborted]),
  };
  try {
    return await run(scope, security);
  } catch (error) {
    return interrupted(error, timeout.signal, shutdown, plan) ??
      thrown(error, plan.operation, settings);
  } finally {
    clearTimeout(timer);
  }
}

/** The answer when the request timed out or the server is shutting down; otherwise undefined. */
function interrupted(
  error: unknown,
  timeout: AbortSignal,
  shutdown: AbortSignal,
  plan: OperationPlan,
): Outcome | undefined {
  if (timeout.aborted && error === timeout.reason) {
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
  return undefined;
}

async function run(scope: RequestScope, security: SecurityEvaluator): Promise<Outcome> {
  const { plan, request, signal } = scope;
  const { operation } = plan;
  // Security runs first, so unauthenticated callers learn nothing about the schemas.
  let identities: Readonly<Record<string, unknown>> | undefined;
  if (operation.security.length > 0) {
    const result = await scope.bounded(
      security(operation.security, request, scope.url, {
        signal,
        request,
        operationId: operation.operationId,
      }),
    );
    if (result.kind === "denied") return denied(result.denial);
    identities = result.security;
  }

  const { input, violations } = readInputParameters(scope);
  if (violations.length > 0) return validationFailed(violations);
  if (operation.body !== undefined) {
    const body = await readInputBody(scope, operation.body);
    if (body.kind === "failed") return body.outcome;
    if (body.kind === "ok") input.body = body.value;
  }

  if (plan.handler === undefined) {
    return fail(501, "NOT_IMPLEMENTED", {
      detail: `Operation '${operation.operationId}' is not implemented yet.`,
    });
  }
  const ctx = { signal, request, operationId: operation.operationId, security: identities };
  return respond(plan, await scope.bounded(plan.handler(input, ctx)), scope.settings);
}

/** Reads, defaults, coerces, and validates every parameter location before the body. */
function readInputParameters(
  scope: RequestScope,
): { input: Record<string, unknown>; violations: Violation[] } {
  const { plan, params, url, request } = scope;
  const input: Record<string, unknown> = {};
  const violations: Violation[] = [];
  for (const { location, key, validator } of plan.locations) {
    let value: unknown = readParameters(location, plan.operation.parameters, {
      params,
      url,
      headers: request.headers,
    });
    if (location !== "path") value = validator.defaults(value);
    value = validator.convert(value);
    violations.push(...validator.check(value, location));
    input[key] = value;
  }
  return { input, violations };
}

type BodyInput =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly outcome: Outcome };

const failed = (outcome: Outcome): BodyInput => ({ kind: "failed", outcome });

/** Reads and validates the declared body; a failure carries its problem response. */
async function readInputBody(scope: RequestScope, body: BodyModel): Promise<BodyInput> {
  const { plan, settings } = scope;
  const result = await scope.bounded(
    readBody(scope.request, body, settings.bodyLimitBytes, scope.signal),
  );
  switch (result.kind) {
    case "too-large":
      return failed(fail(413, "PAYLOAD_TOO_LARGE", {
        detail: `The request body exceeds ${settings.bodyLimitBytes} bytes.`,
      }));
    case "unsupported-media-type":
      return failed(fail(415, "UNSUPPORTED_MEDIA_TYPE", {
        detail: `Expected ${body.mediaType}, got ${result.mediaType ?? "no content type"}.`,
        headers: { "accept-post": body.mediaType },
      }));
    case "malformed":
      return failed(fail(400, "MALFORMED_REQUEST", { detail: result.detail }));
    case "absent":
      return body.required
        ? failed(validationFailed([{
          location: "body",
          pointer: "",
          message: "a request body is required",
        }]))
        : { kind: "absent" };
    case "ok": {
      // Byte bodies are not validated: their schema is a binary string (RFC 0001 A24).
      const violations = result.value instanceof Uint8Array
        ? []
        : plan.body!.check(result.value, "body");
      return violations.length > 0
        ? failed(validationFailed(violations))
        : { kind: "ok", value: result.value };
    }
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

/**
 * Applies the policy to a response that breaks its contract: `enforce` answers 500, and `log`
 * sends the response anyway. Either way, the violation is reported.
 */
function violated(
  plan: OperationPlan,
  settings: PipelineSettings,
  status: number,
  violations: readonly Violation[],
  fallback: () => Response,
  stripped?: Outcome["stripped"],
): Outcome {
  const facts = {
    violation: { status, violations: [...violations] },
    ...(stripped === undefined ? {} : { stripped }),
  };
  if (settings.responseValidation !== "enforce") return { response: fallback(), ...facts };
  return {
    ...fail(500, "RESPONSE_CONTRACT_VIOLATION", {
      detail:
        `Operation '${plan.operation.operationId}' returned a response that its contract does not allow.`,
      ...(settings.development ? { violations } : {}),
    }),
    ...facts,
  };
}

const undeclaredStatus = (status: number): Violation => ({
  location: "response",
  pointer: "",
  message: `status ${status} is not declared`,
});

/** Applies the response policy and serializes a handler result. */
function respond(plan: OperationPlan, result: unknown, settings: PipelineSettings): Outcome {
  if (result instanceof Response) return respondRaw(plan, result, settings);
  if (
    typeof result !== "object" || result === null ||
    typeof (result as { status?: unknown }).status !== "number"
  ) {
    return fail(500, "RESPONSE_CONTRACT_VIOLATION", {
      detail:
        `Operation '${plan.operation.operationId}' returned a value that is not a result object or Response.`,
    });
  }
  return respondResult(plan, result as ResultObject, settings);
}

/** A raw `Response` passes through after the status check (RFC 0001 A26 for `off`). */
function respondRaw(plan: OperationPlan, result: Response, settings: PipelineSettings): Outcome {
  if (settings.responseValidation === "off" || plan.responses.has(result.status)) {
    return { response: result, streaming: result.body !== null };
  }
  const outcome = violated(
    plan,
    settings,
    result.status,
    [undeclaredStatus(result.status)],
    () => result,
  );
  return withBody(outcome, result);
}

interface ResultObject {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: unknown;
}

/** Result headers as HTTP headers; non-string values are JSON-encoded. */
function toHeaders(given: unknown): Headers {
  const headers = new Headers();
  if (typeof given !== "object" || given === null) return headers;
  for (const [name, value] of Object.entries(given)) {
    if (value !== undefined) {
      headers.set(name, typeof value === "string" ? value : JSON.stringify(value));
    }
  }
  return headers;
}

/** Missing required headers, and header values that do not match their schemas. */
function headerViolations(declared: ResponsePlan, given: unknown): Violation[] {
  const violations: Violation[] = [];
  for (const header of declared.model.headers) {
    const value = lookupHeader(given, header.name);
    const pointer = `/headers/${header.name}`;
    if (value === undefined && header.required) {
      violations.push({ location: "response", pointer, message: "required header is missing" });
    }
    if (value === undefined) continue;
    violations.push(
      ...declared.headers.get(header.name)!.check(value, "response").map((v) => ({
        ...v,
        pointer: `${pointer}${v.pointer}`,
      })),
    );
  }
  return violations;
}

/** A serialized result body, with what serializing it found. */
interface Encoded {
  readonly payload: BodyInit | null;
  readonly mediaType?: string;
  readonly streaming: boolean;
  readonly stripped?: Outcome["stripped"];
  readonly violations: readonly Violation[];
}

/** A problem body gets the response status when it has none. */
function withProblemStatus(mediaType: string, value: unknown, status: number): unknown {
  const isProblem = mediaType === "application/problem+json" && typeof value === "object" &&
    value !== null && !("status" in value);
  return isProblem ? { ...value, status } : value;
}

/** Strips, checks, and serializes a result body against its declared response. */
function encodeResult(
  declared: ResponsePlan,
  status: number,
  body: unknown,
  settings: PipelineSettings,
): Encoded {
  const checking = settings.responseValidation !== "off";
  if (declared.model.body === undefined) {
    const violations: Violation[] = checking && body !== undefined
      ? [{ location: "response", pointer: "/body", message: `status ${status} declares no body` }]
      : [];
    return { payload: null, streaming: false, violations };
  }
  const { mediaType } = declared.model.body;
  let value = withProblemStatus(mediaType, body, status);
  let stripped: Outcome["stripped"];
  if (isJsonMediaType(mediaType)) {
    const cleaned = declared.body!.clean(value, settings.development);
    value = cleaned.value;
    if (settings.development && cleaned.removed.length > 0) {
      stripped = { status, removed: cleaned.removed };
    }
  }
  // Streams and bytes are not validated; they are produced or passed through as they are.
  const checkable = checking && !(value instanceof Uint8Array) &&
    !(value instanceof ReadableStream);
  const violations = checkable
    ? declared.body!.check(value, "response").map((v) => ({ ...v, pointer: `/body${v.pointer}` }))
    : [];
  const payload = encodeBody(value, mediaType);
  return {
    payload,
    mediaType,
    streaming: payload instanceof ReadableStream,
    ...(stripped === undefined ? {} : { stripped }),
    violations,
  };
}

/** A result object for an undeclared status: a violation unless the policy is `off`. */
function respondUndeclared(
  plan: OperationPlan,
  settings: PipelineSettings,
  result: ResultObject,
  headers: Headers,
): Outcome {
  const { status, body } = result;
  const send = () => {
    if (body === undefined) return new Response(null, { status, headers });
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(body), { status, headers });
  };
  if (settings.responseValidation === "off") return { response: send() };
  return violated(plan, settings, status, [undeclaredStatus(status)], send);
}

function respondResult(
  plan: OperationPlan,
  result: ResultObject,
  settings: PipelineSettings,
): Outcome {
  const { status } = result;
  const headers = toHeaders(result.headers);
  const declared = plan.responses.get(status);
  if (declared === undefined) return respondUndeclared(plan, settings, result, headers);

  const encoded = encodeResult(declared, status, result.body, settings);
  if (encoded.mediaType !== undefined) headers.set("content-type", encoded.mediaType);
  const violations = [
    ...(settings.responseValidation === "off" ? [] : headerViolations(declared, result.headers)),
    ...encoded.violations,
  ];
  const { payload, streaming, stripped } = encoded;
  const send = () => new Response(payload, { status, headers });
  if (violations.length === 0) {
    return {
      response: send(),
      ...(stripped === undefined ? {} : { stripped }),
      ...(streaming ? { streaming } : {}),
    };
  }
  const outcome = violated(plan, settings, status, violations, send, stripped);
  // A stream replaced by a 500 is never read, so it is cancelled.
  if (outcome.code !== undefined && payload instanceof ReadableStream) {
    void payload.cancel().catch(() => {});
    return outcome;
  }
  return streaming ? { ...outcome, streaming } : outcome;
}
