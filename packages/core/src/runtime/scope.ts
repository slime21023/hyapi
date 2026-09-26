import type { MaybePromise } from "../types.ts";
import { sleep } from "./timers.ts";

type Closer = (deadline?: number) => MaybePromise<void>;
type ScopeState = "open" | "closing" | "closed";

/** `details` carries the error thrown while closing a value adopted after the scope closed. */
export class ScopeClosedError extends Error {
  readonly code = "SCOPE_CLOSED";
  readonly details: unknown;

  constructor(details: unknown = undefined) {
    super("The scope has already been closed.");
    this.name = "ScopeClosedError";
    this.details = details;
  }
}

/** Appends `error`, expanding AggregateErrors so nested scopes report one flat list. */
export function collectError(target: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) collectError(target, nested);
  } else target.push(error);
}

function cleanupTimeout(): Error {
  const error = new Error("Resource cleanup timed out.");
  error.name = "TimeoutError";
  return error;
}

function closerOf(value: unknown): Closer | null {
  if (typeof value !== "object" || value === null || !("close" in value)) return null;
  const close = value.close;
  return typeof close === "function" ? () => close.call(value) : null;
}

/**
 * An ordered set of resources released in reverse registration order. Every closer runs even when
 * earlier ones fail; failures are reported together as one flat AggregateError.
 */
export class Scope {
  readonly #message: string;
  readonly #closers: Closer[] = [];
  #state: ScopeState = "open";
  #closing: Promise<void> | null = null;

  constructor(message: string) {
    this.#message = message;
  }

  get state(): ScopeState {
    return this.#state;
  }

  defer(closer: Closer): void {
    if (this.#state !== "open") throw new ScopeClosedError();
    this.#closers.push(closer);
  }

  /** Registers `value.close()`; a value adopted after the scope closed is closed immediately. */
  async adopt<T>(value: T): Promise<T> {
    const closer = closerOf(value);
    if (this.#state === "open") {
      if (closer) this.#closers.push(closer);
      return value;
    }
    if (closer) {
      try {
        await closer();
      } catch (error) {
        throw new ScopeClosedError(error);
      }
    }
    throw new ScopeClosedError();
  }

  close(deadline?: number, signal?: AbortSignal): Promise<void> {
    if (this.#closing) return this.#closing;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#closing = promise;
    void this.#closeAll(deadline, signal).then(resolve, reject);
    return promise;
  }

  async #closeAll(deadline?: number, signal?: AbortSignal): Promise<void> {
    this.#state = "closing";
    const errors: unknown[] = [];
    let aborted = false;
    let abortReason: unknown;
    const noteAbort = () => {
      if (aborted || !signal?.aborted) return;
      aborted = true;
      abortReason = signal.reason;
    };
    for (const closer of this.#closers.reverse()) {
      try {
        noteAbort();
        const result = closer(deadline);
        // A closer returning its own scope's close promise cannot wait for itself.
        if (result === undefined || result === this.#closing) continue;
        if (deadline === undefined && !signal) {
          await result;
          continue;
        }
        const pending = Promise.resolve(result);
        // The closer may settle after the deadline; do not leave a rejection unobserved.
        void pending.catch(() => undefined);
        if (signal?.aborted) continue;
        const remaining = deadline === undefined ? undefined : deadline - Date.now();
        if (remaining !== undefined && remaining <= 0) throw cleanupTimeout();
        const timer = remaining === undefined ? undefined : new AbortController();
        const abort = signal ? Promise.withResolvers<never>() : undefined;
        const onAbort = () => abort?.reject(signal?.reason);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
          const waits: Promise<unknown>[] = [
            pending,
          ];
          if (timer && remaining !== undefined) {
            waits.push(
              sleep(remaining, timer.signal).then(() => {
                throw cleanupTimeout();
              }),
            );
          }
          if (abort) waits.push(abort.promise);
          await Promise.race(waits);
        } finally {
          timer?.abort();
          signal?.removeEventListener("abort", onAbort);
        }
      } catch (error) {
        if (signal?.aborted && error === signal.reason) noteAbort();
        else collectError(errors, error);
      }
    }
    this.#closers.length = 0;
    this.#state = "closed";
    if (aborted) collectError(errors, abortReason);
    if (errors.length > 0) throw new AggregateError(errors, this.#message);
  }
}
