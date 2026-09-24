import type { MaybePromise } from "./types.ts";
import { AppError } from "./errors.ts";

export type Closer = () => MaybePromise<void>;
export type ScopeState = "open" | "closing" | "closed";

/** `details` carries the error thrown while closing a value adopted after the scope closed. */
export function scopeClosedError(details: unknown = undefined): AppError {
  return new AppError(500, "SCOPE_CLOSED", "The scope has already been closed.", details, false);
}

/** Appends `error`, expanding AggregateErrors so nested scopes report one flat list. */
export function collectError(target: unknown[], error: unknown): void {
  if (error instanceof AggregateError) target.push(...error.errors);
  else target.push(error);
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
    if (this.#state !== "open") throw scopeClosedError();
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
        throw scopeClosedError(error);
      }
    }
    throw scopeClosedError();
  }

  close(): Promise<void> {
    this.#closing ??= this.#closeAll();
    return this.#closing;
  }

  async #closeAll(): Promise<void> {
    this.#state = "closing";
    const errors: unknown[] = [];
    for (const closer of this.#closers.reverse()) {
      try {
        await closer();
      } catch (error) {
        collectError(errors, error);
      }
    }
    this.#closers.length = 0;
    this.#state = "closed";
    if (errors.length > 0) throw new AggregateError(errors, this.#message);
  }
}
