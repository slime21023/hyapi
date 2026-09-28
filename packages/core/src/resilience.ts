/** Wraps operations with retry, timeout, circuit-breaker, and bulkhead policies. @module */

import type { MaybePromise } from "./types.ts";
import { MAX_TIMER_MS, sleep } from "./runtime/timers.ts";

/** Retry behavior applied after a failed operation attempt. */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs?: number;
  readonly backoff?: "exponential";
  readonly jitter?: boolean;
  readonly retryOn?: (error: unknown) => boolean;
}

/** Failure threshold and recovery behavior for one wrapped operation. */
export interface CircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxAttempts?: number;
}

/** Concurrency and queue limits for one wrapped operation. */
export interface BulkheadPolicy {
  readonly maxConcurrent: number;
  readonly queueSize?: number;
}

/** Combined resilience behavior retained by one wrapped operation. */
export interface ResiliencePolicy {
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly circuitBreaker?: CircuitBreakerPolicy;
  readonly bulkhead?: BulkheadPolicy;
}

/** Reports a timeout, open circuit, or rejected bulkhead admission. */
export class ResilienceError extends Error {
  constructor(
    readonly reason: "timeout" | "circuit_open" | "bulkhead_rejected",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResilienceError";
  }
}

const NON_BREAKER_FAILURE_REASONS: Readonly<Record<string, true>> = {
  client: true,
  contract: true,
  validation: true,
  business: true,
  deadline: true,
  aborted: true,
};

/**
 * Wraps an operation with retained resilience state.
 *
 * Timed-out operations are abandoned: they release their bulkhead slot and count as
 * circuit-breaker failures even if they never settle.
 *
 * @param operation Work to execute.
 * @param policy Timeout, retry, circuit-breaker, and bulkhead settings.
 */
export function withResilience<TArgs extends readonly unknown[], TResult>(
  operation: (...args: TArgs) => MaybePromise<TResult>,
  policy: ResiliencePolicy,
): (...args: TArgs) => Promise<TResult> {
  validatePolicy(policy);
  const breaker = policy.circuitBreaker ? new CircuitBreaker(policy.circuitBreaker) : undefined;
  const bulkhead = policy.bulkhead ? new Bulkhead(policy.bulkhead) : undefined;
  return (...args: TArgs): Promise<TResult> => {
    const exec = async (signal: AbortSignal): Promise<TResult> => {
      if (breaker) return await breaker.execute(() => operation(...args), signal);
      return await operation(...args);
    };
    return runWithRetry(
      (signal) => bulkhead ? bulkhead.execute(exec, signal) : exec(signal),
      policy.retry,
      policy.timeoutMs,
    );
  };
}

function computeRetryDelay(policy: RetryPolicy, attempt: number): number {
  const base = policy.backoff === "exponential"
    ? policy.initialDelayMs * 2 ** (attempt - 1)
    : policy.initialDelayMs;
  const capped = Math.min(base, policy.maxDelayMs ?? MAX_TIMER_MS, MAX_TIMER_MS);
  return policy.jitter ? Math.floor(Math.random() * (capped + 1)) : capped;
}

async function runWithRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy | undefined,
  timeoutMs: number | undefined,
): Promise<T> {
  const maxAttempts = policy?.maxAttempts ?? 1;
  for (let attempt = 1;; attempt += 1) {
    try {
      return await runAttempt(operation, timeoutMs);
    } catch (error) {
      if (!policy || attempt >= maxAttempts || (policy.retryOn && !policy.retryOn(error))) {
        throw error;
      }
      const delayMs = computeRetryDelay(policy, attempt);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

function runAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  const controller = new AbortController();
  if (timeoutMs === undefined) return operation(controller.signal);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    const error = new ResilienceError("timeout", "Operation timed out.");
    controller.abort(error);
    reject(error);
  }, timeoutMs);
  operation(controller.signal).then(resolve, reject).finally(() => clearTimeout(timer));
  return promise;
}

class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;
  private openedAt = 0;
  private probes = 0;
  private generation = 0;
  private lastFailure: unknown = undefined;
  constructor(private readonly policy: CircuitBreakerPolicy) {}

  async execute<T>(operation: () => MaybePromise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw signal.reason;
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.policy.resetTimeoutMs) {
        throw new ResilienceError("circuit_open", "Circuit breaker is open.", {
          cause: this.lastFailure,
        });
      }
      this.state = "half-open";
      this.generation += 1;
      this.probes = 0;
    }
    let probe = false;
    if (this.state === "half-open") {
      if (this.probes >= (this.policy.halfOpenMaxAttempts ?? 1)) {
        throw new ResilienceError("circuit_open", "Circuit breaker is half-open.", {
          cause: this.lastFailure,
        });
      }
      this.probes += 1;
      probe = true;
    }
    const generation = this.generation;
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      this.recordFailure(generation, probe, signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        this.recordFailure(generation, probe, error);
      }
      throw error;
    }
    signal?.removeEventListener("abort", onAbort);
    if (!settled) {
      settled = true;
      this.recordSuccess(generation, probe);
    }
    return result;
  }

  private recordSuccess(generation: number, probe: boolean): void {
    if (generation !== this.generation) return;
    if (probe) {
      this.state = "closed";
      this.generation += 1;
      this.probes = 0;
    }
    this.failures = 0;
  }

  private recordFailure(generation: number, probe: boolean, error: unknown): void {
    if (generation !== this.generation) return;
    const counts = countsAsBreakerFailure(error);
    if (probe) {
      if (counts) {
        this.open(error);
      } else {
        this.probes -= 1;
      }
      return;
    }
    if (!counts) return;
    this.failures += 1;
    this.lastFailure = error;
    if (this.failures >= this.policy.failureThreshold) this.open(error);
  }

  private open(error: unknown): void {
    this.state = "open";
    this.generation += 1;
    this.openedAt = Date.now();
    this.lastFailure = error;
  }
}

class Bulkhead {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void }> = [];
  constructor(private readonly policy: BulkheadPolicy) {}

  async execute<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) throw signal.reason;
    if (this.active >= this.policy.maxConcurrent) {
      if (this.waiters.length >= (this.policy.queueSize ?? 0)) {
        throw new ResilienceError("bulkhead_rejected", "Bulkhead queue is full.");
      }
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const waiter = {
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index === -1) return;
        this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      await promise;
    } else {
      this.active += 1;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", release);
      this.active -= 1;
      this.releaseNext();
    };
    if (signal.aborted) {
      release();
      throw signal.reason;
    }
    signal.addEventListener("abort", release, { once: true });
    try {
      return await operation(signal);
    } finally {
      release();
    }
  }

  private releaseNext(): void {
    if (this.active >= this.policy.maxConcurrent) return;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    this.active += 1;
    waiter.resolve();
  }
}

function countsAsBreakerFailure(error: unknown): boolean {
  if (error instanceof ResilienceError) return error.reason === "timeout";
  if (typeof error !== "object" || error === null) return true;
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason !== "string" || NON_BREAKER_FAILURE_REASONS[reason] !== true;
}

function validatePolicy(policy: ResiliencePolicy): void {
  if (
    policy.timeoutMs !== undefined &&
    (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 1 ||
      policy.timeoutMs > MAX_TIMER_MS)
  ) {
    throw new Error("Resilience timeoutMs must be positive and at most 2147483647.");
  }
  const retry = policy.retry;
  if (retry) {
    if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
      throw new Error("Resilience retry maxAttempts must be a positive integer.");
    }
    if (
      !Number.isFinite(retry.initialDelayMs) || retry.initialDelayMs < 0 ||
      retry.initialDelayMs > MAX_TIMER_MS
    ) {
      throw new Error(
        "Resilience retry initialDelayMs must be non-negative and at most 2147483647.",
      );
    }
    if (
      retry.maxDelayMs !== undefined &&
      (!Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < 0 ||
        retry.maxDelayMs > MAX_TIMER_MS)
    ) {
      throw new Error("Resilience retry maxDelayMs must be non-negative and at most 2147483647.");
    }
    if (retry.backoff !== undefined && retry.backoff !== "exponential") {
      throw new Error("Resilience retry backoff must be 'exponential' when provided.");
    }
    if (retry.jitter !== undefined && typeof retry.jitter !== "boolean") {
      throw new Error("Resilience retry jitter must be a boolean when provided.");
    }
    if (retry.retryOn !== undefined && typeof retry.retryOn !== "function") {
      throw new Error("Resilience retry retryOn must be a function when provided.");
    }
  }
  if (
    policy.circuitBreaker &&
    (!Number.isInteger(policy.circuitBreaker.failureThreshold) ||
      policy.circuitBreaker.failureThreshold < 1)
  ) {
    throw new Error("Circuit breaker failureThreshold must be a positive integer.");
  }
  if (
    policy.circuitBreaker &&
    (!Number.isFinite(policy.circuitBreaker.resetTimeoutMs) ||
      policy.circuitBreaker.resetTimeoutMs < 1 ||
      policy.circuitBreaker.resetTimeoutMs > MAX_TIMER_MS)
  ) {
    throw new Error("Circuit breaker resetTimeoutMs must be positive and at most 2147483647.");
  }
  if (
    policy.circuitBreaker?.halfOpenMaxAttempts !== undefined &&
    (!Number.isInteger(policy.circuitBreaker.halfOpenMaxAttempts) ||
      policy.circuitBreaker.halfOpenMaxAttempts < 1)
  ) {
    throw new Error("Circuit breaker halfOpenMaxAttempts must be a positive integer.");
  }
  if (
    policy.bulkhead &&
    (!Number.isInteger(policy.bulkhead.maxConcurrent) || policy.bulkhead.maxConcurrent < 1)
  ) {
    throw new Error("Bulkhead maxConcurrent must be a positive integer.");
  }
  if (
    policy.bulkhead?.queueSize !== undefined &&
    (!Number.isInteger(policy.bulkhead.queueSize) || policy.bulkhead.queueSize < 0)
  ) {
    throw new Error("Bulkhead queueSize must be a non-negative integer.");
  }
}
