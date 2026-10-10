// The request half of the request flow: one matched request through security, parameters, the
// body, and the handler, within its deadline. The response half is respond.ts.
import Type from "typebox";
import { cloneSchema } from "../base/typebox.ts";
import type { BodyModel, OperationModel, ParameterLocation } from "../contract/model.ts";
import { readBody } from "./body.ts";
import { readParameters } from "./params.ts";
import { describeError, HttpError, type Violation } from "./problem.ts";
import {
  fail,
  type Outcome,
  planResponses,
  respond,
  type ResponsePlan,
  type ResponsePolicy,
} from "./respond.ts";
import type { Denial, SecurityEvaluator } from "./security.ts";
import type { Validator, ValidatorFactory } from "./validation.ts";

/** A bound handler, with its contract types erased once it is checked against the model. */
// deno-lint-ignore no-explicit-any
export type AnyHandler = (input: any, ctx: any) => unknown;

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
  /** The request body limit of this operation. */
  readonly bodyLimitBytes: number;
  readonly locations: readonly LocationPlan[];
  readonly body: Validator | undefined;
  readonly responses: ReadonlyMap<number, ResponsePlan>;
  /** The effective requirement in OpenAPI form, as verifiers receive it. */
  readonly requirements: readonly Readonly<Record<string, readonly string[]>>[];
}

const LOCATION_ORDER: readonly ParameterLocation[] = ["path", "query", "header", "cookie"];

/** Prepares the validators and lookups of one operation. */
export function planOperation(
  operation: OperationModel,
  handler: AnyHandler | undefined,
  limits: { readonly timeoutMs: number; readonly bodyLimitBytes: number },
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
  return {
    operation,
    handler,
    timeoutMs: limits.timeoutMs,
    bodyLimitBytes: limits.bodyLimitBytes,
    locations,
    body: operation.body ? validators(operation.body.schema) : undefined,
    responses: planResponses(operation.responses, validators),
    requirements: operation.security.map((alternative) =>
      Object.freeze(Object.fromEntries(alternative.map(({ scheme, scopes }) => [scheme, scopes])))
    ),
  };
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

/** A routed request: what the application knows before the operation runs. */
export interface Incoming {
  readonly request: Request;
  readonly url: URL;
  /** Decoded path parameters. */
  readonly params: Readonly<Record<string, string>>;
  readonly requestId: string | undefined;
}

/** One request in flight: what its steps read, and how they stay within its deadline. */
interface RequestScope extends Incoming {
  readonly plan: OperationPlan;
  readonly settings: ResponsePolicy;
  /** Aborts on client disconnect, the request timeout, and forced shutdown. */
  readonly signal: AbortSignal;
  /** Races work against `signal`, rejecting with its reason. */
  readonly bounded: <Result>(work: Promise<Result> | Result) => Promise<Result>;
}

/**
 * The abort reason of requests that the application cancels at shutdown. The application aborts
 * each in-flight request's own controller with it; requests never listen to a signal that lives
 * as long as the application, which would keep every request reachable until shutdown.
 */
export const SHUTTING_DOWN: DOMException = new DOMException(
  "The server is shutting down.",
  "AbortError",
);

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
  incoming: Incoming,
  settings: ResponsePolicy,
  security: SecurityEvaluator,
  controller: AbortController,
): Promise<Outcome> {
  // One signal for the whole request: client disconnect, the request timeout, and forced
  // shutdown, for which the application aborts `controller`. The timeout covers verifiers, body
  // reading, and the handler. The request's own signal is collected with the request, so its
  // listener needs no removal.
  const { request } = incoming;
  const { signal } = controller;
  if (request.signal.aborted) controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", () => controller.abort(request.signal.reason), {
    once: true,
  });
  const timeout = new DOMException("The request timed out.", "TimeoutError");
  const timer = setTimeout(() => controller.abort(timeout), plan.timeoutMs);
  const aborted = rejectOnAbort(signal);
  const scope: RequestScope = {
    ...incoming,
    plan,
    settings,
    signal,
    bounded: (work) => Promise.race([Promise.resolve(work), aborted]),
  };
  try {
    return await run(scope, security);
  } catch (error) {
    return interrupted(error, timeout, plan) ?? thrown(error, plan.operation, settings);
  } finally {
    clearTimeout(timer);
  }
}

/** The answer when the request timed out or the server is shutting down; otherwise undefined. */
function interrupted(
  error: unknown,
  timeout: DOMException,
  plan: OperationPlan,
): Outcome | undefined {
  if (error === timeout) {
    return fail(503, "REQUEST_TIMEOUT", {
      detail: `The request did not complete within ${plan.timeoutMs} ms.`,
    });
  }
  if (error === SHUTTING_DOWN) {
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
        requirements: plan.requirements,
        requestId: scope.requestId,
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
  const ctx = {
    signal,
    request,
    operationId: operation.operationId,
    security: identities,
    requestId: scope.requestId,
  };
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
  const { plan } = scope;
  const result = await scope.bounded(
    readBody(scope.request, body, plan.bodyLimitBytes, scope.signal),
  );
  switch (result.kind) {
    case "too-large":
      return failed(fail(413, "PAYLOAD_TOO_LARGE", {
        detail: `The request body exceeds ${plan.bodyLimitBytes} bytes.`,
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

function thrown(error: unknown, operation: OperationModel, settings: ResponsePolicy): Outcome {
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
