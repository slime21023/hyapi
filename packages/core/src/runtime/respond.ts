// The response half of the request flow (Review 0002 D2): what a handler result becomes, checked
// against the operation's declared responses under the response policy, and the problem responses
// that HyAPI itself chooses. Deciding which status a situation gets is L3 policy (ADR 0003 §2).
import { isJsonMediaType } from "../base/http.ts";
import type { OperationModel, ResponseModel } from "../contract/model.ts";
import { encodeBody } from "./body.ts";
import { problemResponse, type Violation } from "./problem.ts";
import type { RouteMatch } from "./routing.ts";
import type { Denial } from "./security.ts";
import type { Validator, ValidatorFactory } from "./validation.ts";

/** How responses that do not match their schema are handled. */
export type ResponseValidation = "off" | "log" | "enforce";

/** How responses are checked, and whether error responses carry diagnostic details. */
export interface ResponsePolicy {
  readonly development: boolean;
  readonly responseValidation: ResponseValidation;
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

export interface ResponsePlan {
  readonly model: ResponseModel;
  readonly body: Validator | undefined;
  /** One validator per declared header, by header name. */
  readonly headers: ReadonlyMap<string, Validator>;
}

/** Prepares the validators of every declared response, by status. */
export function planResponses(
  responses: readonly ResponseModel[],
  validators: ValidatorFactory,
): ReadonlyMap<number, ResponsePlan> {
  return new Map(
    responses.map((response): [number, ResponsePlan] => [
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
}

/** What the response half needs of an operation plan. */
interface ResponseTarget {
  readonly operation: Pick<OperationModel, "operationId">;
  readonly responses: ReadonlyMap<number, ResponsePlan>;
}

/** A problem response that HyAPI produces, with its code recorded in the outcome. */
export function fail(
  status: number,
  code: string,
  options: Parameters<typeof problemResponse>[2] = {},
): Outcome {
  return { response: problemResponse(status, code, options), code };
}

/** The problem code of each unmatched outcome, for events. */
export const UNMATCHED_CODES = {
  "not-found": "NOT_FOUND",
  "method-not-allowed": "METHOD_NOT_ALLOWED",
  "malformed-path": "MALFORMED_REQUEST",
} as const;

/** The answer to a request that arrives while the application is closing. */
export const shuttingDown = () =>
  problemResponse(503, "SHUTTING_DOWN", {
    detail: "The server is shutting down.",
    headers: { connection: "close" },
  });

/** The problem response for a request that matches no operation. */
export function unmatched(
  match: Exclude<RouteMatch, { kind: "found" }>,
  method: string,
  pathname: string,
): Response {
  switch (match.kind) {
    case "malformed-path":
      return problemResponse(400, "MALFORMED_REQUEST", {
        detail: "The path is not valid percent-encoding.",
      });
    case "not-found":
      return problemResponse(404, "NOT_FOUND", { detail: `No operation matches ${pathname}.` });
  }
  return problemResponse(405, "METHOD_NOT_ALLOWED", {
    detail: `${method} is not declared for ${pathname}.`,
    headers: { allow: match.allow.join(", ") },
  });
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
  plan: ResponseTarget,
  settings: ResponsePolicy,
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
export function respond(plan: ResponseTarget, result: unknown, settings: ResponsePolicy): Outcome {
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
function respondRaw(plan: ResponseTarget, result: Response, settings: ResponsePolicy): Outcome {
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
  settings: ResponsePolicy,
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
  plan: ResponseTarget,
  settings: ResponsePolicy,
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
  plan: ResponseTarget,
  result: ResultObject,
  settings: ResponsePolicy,
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
