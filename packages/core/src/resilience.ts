import type { MaybePromise } from "./types.ts";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs?: number;
  readonly backoff?: "exponential";
  readonly jitter?: boolean;
  readonly retryOn?: (error: unknown) => boolean;
}

export interface CircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxAttempts?: number;
}

export interface BulkheadPolicy {
  readonly maxConcurrent: number;
  readonly queueSize?: number;
}

export interface ResiliencePolicy {
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly circuitBreaker?: CircuitBreakerPolicy;
  readonly bulkhead?: BulkheadPolicy;
}

export class ResilienceError extends Error {
  constructor(readonly reason: "timeout" | "circuit_open" | "bulkhead_rejected", message: string) {
    super(message);
    this.name = "ResilienceError";
  }
}

export function withResilience<TArgs extends readonly unknown[], TResult>(
  operation: (...args: TArgs) => MaybePromise<TResult>,
  policy: ResiliencePolicy,
): (...args: TArgs) => Promise<TResult> {
  validatePolicy(policy);
  const breaker = policy.circuitBreaker ? new CircuitBreaker(policy.circuitBreaker) : undefined;
  const bulkhead = policy.bulkhead ? new Bulkhead(policy.bulkhead) : undefined;
  return async (...args: TArgs): Promise<TResult> => {
    const execute = async (): Promise<TResult> => {
      if (breaker) return await breaker.execute(() => operation(...args));
      return await operation(...args);
    };
    const guarded = bulkhead ? () => bulkhead.execute(execute) : execute;
    return await runWithRetry(guarded, policy.retry, policy.timeoutMs);
  };
}

async function runWithRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy | undefined,
  timeoutMs: number | undefined,
): Promise<T> {
  const retry = policy ?? { maxAttempts: 1, initialDelayMs: 0 };
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const result = operation();
      return timeoutMs === undefined ? await result : await timeout(result, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === retry.maxAttempts || (retry.retryOn && !retry.retryOn(error))) throw error;
      const base = retry.backoff === "exponential"
        ? retry.initialDelayMs * 2 ** (attempt - 1)
        : retry.initialDelayMs;
      const capped = Math.min(base, retry.maxDelayMs ?? base);
      const delayMs = retry.jitter ? Math.floor(Math.random() * (capped + 1)) : capped;
      if (delayMs > 0) await delay(delayMs);
    }
  }
  throw lastError;
}

class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probes = 0;
  constructor(private readonly policy: CircuitBreakerPolicy) {}

  async execute<T>(operation: () => Promise<T> | T): Promise<T> {
    const now = Date.now();
    if (this.openedAt > 0 && now - this.openedAt < this.policy.resetTimeoutMs) {
      throw new ResilienceError("circuit_open", "Circuit breaker is open.");
    }
    if (this.openedAt > 0) {
      const maxProbes = this.policy.halfOpenMaxAttempts ?? 1;
      if (this.probes >= maxProbes) {
        throw new ResilienceError("circuit_open", "Circuit breaker is half-open.");
      }
      this.probes += 1;
    }
    try {
      const result = await operation();
      this.failures = 0;
      this.openedAt = 0;
      this.probes = 0;
      return result;
    } catch (error) {
      this.probes = Math.max(0, this.probes - 1);
      if (countsAsBreakerFailure(error)) {
        this.failures += 1;
        if (this.failures >= this.policy.failureThreshold) this.openedAt = Date.now();
      }
      throw error;
    }
  }
}

class Bulkhead {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
  }> = [];
  constructor(private readonly policy: BulkheadPolicy) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let granted = false;
    if (this.active >= this.policy.maxConcurrent) {
      if (this.waiters.length >= (this.policy.queueSize ?? 0)) {
        throw new ResilienceError("bulkhead_rejected", "Bulkhead queue is full.");
      }
      await new Promise<void>((resolve) => {
        this.waiters.push({
          resolve: () => {
            granted = true;
            resolve();
          },
        });
      });
    }
    if (!granted) this.active += 1;
    try {
      return await operation();
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.releaseNext();
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
  if (error instanceof ResilienceError) return false;
  if (typeof error !== "object" || error === null) return true;
  const reason = (error as { reason?: unknown }).reason;
  return reason !== "client" && reason !== "contract" && reason !== "validation" &&
    reason !== "business";
}

function validatePolicy(policy: ResiliencePolicy): void {
  if (
    policy.timeoutMs !== undefined && (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 1)
  ) {
    throw new Error("Resilience timeoutMs must be positive.");
  }
  if (
    policy.retry && (!Number.isInteger(policy.retry.maxAttempts) || policy.retry.maxAttempts < 1)
  ) {
    throw new Error("Resilience retry maxAttempts must be a positive integer.");
  }
  if (
    policy.retry &&
    (!Number.isFinite(policy.retry.initialDelayMs) || policy.retry.initialDelayMs < 0)
  ) {
    throw new Error("Resilience retry initialDelayMs must be non-negative.");
  }
  if (
    policy.retry?.maxDelayMs !== undefined &&
    (!Number.isFinite(policy.retry.maxDelayMs) || policy.retry.maxDelayMs < 0)
  ) {
    throw new Error("Resilience retry maxDelayMs must be non-negative.");
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
      policy.circuitBreaker.resetTimeoutMs < 1)
  ) {
    throw new Error("Circuit breaker resetTimeoutMs must be positive.");
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

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ResilienceError("timeout", "Operation timed out.")),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
