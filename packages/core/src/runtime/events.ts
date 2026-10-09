import type { ErrorInfo, Violation } from "./problem.ts";

/** Present on events about a request when `createApp({ requestId })` is on. */
interface RequestScoped {
  readonly requestId?: string;
}

/** A read-only event about the application. Listeners cannot change requests or responses. */
export type AppEvent =
  | RequestScoped & {
    /** A matched request starts its operation. */
    readonly type: "operation.start";
    readonly operationId: string;
    readonly method: string;
    /** The declared path template, such as `/users/{id}`. */
    readonly path: string;
    readonly deprecated: boolean;
  }
  | RequestScoped & {
    /** A matched request finished its operation. */
    readonly type: "operation.end";
    readonly operationId: string;
    readonly method: string;
    readonly path: string;
    readonly deprecated: boolean;
    readonly status: number;
    /** Time until the response headers were ready; streamed bodies may continue afterwards. */
    readonly durationMs: number;
    /** The problem `code` for framework-generated error responses. */
    readonly code?: string;
    /** The error a handler or verifier threw, when the response is a 500. */
    readonly error?: ErrorInfo;
  }
  | RequestScoped & {
    /** Security denied a matched request. Credentials are never included. */
    readonly type: "security.denied";
    readonly operationId: string;
    readonly method: string;
    readonly path: string;
    readonly status: 401 | 403;
    readonly reason: "missing" | "invalid" | "insufficient-scope";
    /** The schemes the operation accepts, in declaration order. */
    readonly schemes: readonly string[];
    /** For `insufficient-scope`: the scopes the failing alternative requires. */
    readonly requiredScopes?: readonly string[];
  }
  | RequestScoped & {
    /** A request matched no operation: 404, 405, or 400 for a malformed path. */
    readonly type: "request.unmatched";
    readonly method: string;
    /** The request path as received. */
    readonly path: string;
    readonly status: number;
    readonly code: string;
  }
  | RequestScoped & {
    /** A response did not match its contract (policy `log` or `enforce`). */
    readonly type: "response.violation";
    readonly operationId: string;
    readonly status: number;
    readonly violations: readonly Violation[];
  }
  | RequestScoped & {
    /** Development mode only: undeclared response fields were removed. */
    readonly type: "response.stripped";
    readonly operationId: string;
    readonly status: number;
    readonly removed: readonly string[];
  }
  | {
    /** A startup warning, such as an unnamed schema. */
    readonly type: "startup.warning";
    readonly code: string;
    readonly message: string;
    readonly operationId?: string;
  }
  | {
    /** A lifecycle resource failed to start or stop. */
    readonly type: "lifecycle.error";
    readonly name: string;
    readonly phase: "start" | "stop";
    readonly error: ErrorInfo;
  };

/** Receives every event. Errors it throws or rejects with are contained. */
export type EventListener = (event: AppEvent) => void | Promise<void>;

export type Emit = (event: AppEvent) => void;

/**
 * Creates the event channel. Without a listener, events that report problems (violations,
 * stripped fields, startup warnings, lifecycle errors) fall back to `console.warn`, so the `log`
 * policy is never silent.
 */
export function createEmitter(listener: EventListener | undefined): Emit {
  if (listener === undefined) return warnAboutProblems;
  return (event) => deliver(listener, event);
}

/**
 * Events that report a problem with the application itself. Routine traffic, such as 404s and
 * denied requests, is not a problem: warning about it would let any client flood the log.
 */
const PROBLEM_EVENTS: ReadonlySet<AppEvent["type"]> = new Set([
  "response.violation",
  "response.stripped",
  "startup.warning",
  "lifecycle.error",
]);

/** The default without a listener: problem events go to `console.warn`. */
function warnAboutProblems(event: AppEvent): void {
  if (!PROBLEM_EVENTS.has(event.type)) return;
  console.warn(JSON.stringify({ hyapi: event.type, ...event }));
}

/** Calls the listener with a frozen event; whatever it throws or rejects with is contained. */
function deliver(listener: EventListener, event: AppEvent): void {
  try {
    const result = listener(Object.freeze(event));
    if (result instanceof Promise) result.catch(containListenerError);
  } catch (error) {
    containListenerError(error);
  }
}

function containListenerError(error: unknown): void {
  console.error(
    "[hyapi] an event listener failed:",
    error instanceof Error ? error.message : error,
  );
}
