import type { Violation } from "./problem.ts";

/** A read-only event about the application. Listeners cannot change requests or responses. */
export type AppEvent =
  | {
    /** A matched request starts its operation. */
    readonly type: "operation.start";
    readonly operationId: string;
    readonly method: string;
    /** The declared path template, such as `/users/{id}`. */
    readonly path: string;
    readonly deprecated: boolean;
  }
  | {
    /** A matched request finished its operation. */
    readonly type: "operation.end";
    readonly operationId: string;
    readonly method: string;
    readonly path: string;
    readonly deprecated: boolean;
    readonly status: number;
    readonly durationMs: number;
    /** The problem `code` for framework-generated error responses. */
    readonly code?: string;
    /** The error a handler or verifier threw, when the response is a 500. */
    readonly error?: { readonly name: string; readonly message: string };
  }
  | {
    /** A response did not match its contract (policy `log` or `enforce`). */
    readonly type: "response.violation";
    readonly operationId: string;
    readonly status: number;
    readonly violations: readonly Violation[];
  }
  | {
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
    readonly error: { readonly name: string; readonly message: string };
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

/** The default without a listener: problem events go to `console.warn`. */
function warnAboutProblems(event: AppEvent): void {
  if (event.type === "operation.start" || event.type === "operation.end") return;
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
