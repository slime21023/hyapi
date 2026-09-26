import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ResilienceError, withResilience } from "@hyapi/core";

Deno.test("withResilience retries failures with an explicit retry policy", async () => {
  let attempts = 0;
  const operation = withResilience(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary");
      return "ok";
    },
    {
      retry: {
        maxAttempts: 3,
        initialDelayMs: 0,
        retryOn: () => true,
      },
    },
  );
  assertEquals(await operation(), "ok");
  assertEquals(attempts, 3);
});

Deno.test("withResilience opens a circuit after the failure threshold", async () => {
  const operation = withResilience(
    async () => {
      throw new Error("down");
    },
    { circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 1000 } },
  );
  await assertRejects(() => operation(), Error, "down");
  await assertRejects(() => operation(), Error, "down");
  await assertRejects(() => operation(), ResilienceError, "Circuit breaker is open");
});

Deno.test("withResilience rejects work when the bulkhead is full", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => release = resolve);
  const operation = withResilience(
    async () => {
      await pending;
      return "done";
    },
    { bulkhead: { maxConcurrent: 1, queueSize: 0 } },
  );
  const first = operation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assertRejects(() => operation(), ResilienceError, "Bulkhead queue is full");
  release?.();
  assertEquals(await first, "done");
});

Deno.test("withResilience releases bulkhead work in FIFO order", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => releaseFirst = resolve);
  const started: number[] = [];
  let calls = 0;
  const operation = withResilience(
    async () => {
      const call = ++calls;
      started.push(call);
      if (call === 1) await firstPending;
      return call;
    },
    { bulkhead: { maxConcurrent: 1, queueSize: 2 } },
  );

  const first = operation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = operation();
  const third = operation();
  releaseFirst?.();

  assertEquals(await Promise.all([first, second, third]), [1, 2, 3]);
  assertEquals(started, [1, 2, 3]);
});

Deno.test("circuit breakers ignore caller-classified failures", async () => {
  class ClassifiedError extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  }
  const reasons = ["client", "contract", "deadline", "aborted"];
  let attempts = 0;
  const operation = withResilience(
    async () => {
      const reason = reasons[attempts];
      attempts += 1;
      if (reason) throw new ClassifiedError(reason);
      throw new Error("down");
    },
    { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 1000 } },
  );

  for (const reason of reasons) {
    await assertRejects(() => operation(), ClassifiedError, reason);
  }
  await assertRejects(() => operation(), Error, "down");
  await assertRejects(() => operation(), ResilienceError, "Circuit breaker is open");
  assertEquals(attempts, reasons.length + 1);
});

Deno.test("circuit breakers close after a successful half-open probe", async () => {
  let failing = true;
  const operation = withResilience(
    async () => {
      if (failing) throw new Error("down");
      return "ok";
    },
    { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 20 } },
  );

  await assertRejects(() => operation(), Error, "down");
  const open = await assertRejects(() => operation(), ResilienceError, "Circuit breaker is open");
  assertEquals((open.cause as Error).message, "down");
  await delay(30);
  failing = false;
  assertEquals(await operation(), "ok");
  assertEquals(await Promise.all([operation(), operation()]), ["ok", "ok"]);
});

Deno.test("circuit breakers limit concurrent half-open probes", async () => {
  let releaseProbe: (() => void) | undefined;
  const probePending = new Promise<void>((resolve) => releaseProbe = resolve);
  let failing = true;
  const operation = withResilience(
    async () => {
      if (failing) throw new Error("down");
      await probePending;
      return "ok";
    },
    { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 20, halfOpenMaxAttempts: 1 } },
  );

  await assertRejects(() => operation(), Error, "down");
  await delay(30);
  failing = false;
  const probe = operation();
  const rejected = await assertRejects(
    () => operation(),
    ResilienceError,
    "Circuit breaker is half-open",
  );
  assertEquals(rejected.reason, "circuit_open");
  releaseProbe?.();
  assertEquals(await probe, "ok");
});

Deno.test("circuit breakers ignore late successes from calls started before opening", async () => {
  let releaseSlow: (() => void) | undefined;
  const slowPending = new Promise<void>((resolve) => releaseSlow = resolve);
  let calls = 0;
  const operation = withResilience(
    async () => {
      calls += 1;
      if (calls === 1) {
        await slowPending;
        return "slow";
      }
      throw new Error("down");
    },
    { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 1000 } },
  );

  const slow = operation();
  await assertRejects(() => operation(), Error, "down");
  releaseSlow?.();
  assertEquals(await slow, "slow");
  await assertRejects(() => operation(), ResilienceError, "Circuit breaker is open");
});

Deno.test("timed-out bulkhead holders hand their slot to the next waiter exactly once", async () => {
  const firstHold = Promise.withResolvers<void>();
  const thirdHold = Promise.withResolvers<void>();
  const started: number[] = [];
  let calls = 0;
  const operation = withResilience(
    async () => {
      const call = ++calls;
      started.push(call);
      if (call === 1) await firstHold.promise;
      if (call === 3) await thirdHold.promise;
      return call;
    },
    { timeoutMs: 20, bulkhead: { maxConcurrent: 1, queueSize: 1 } },
  );

  const first = operation();
  const queued = operation();
  await assertRejects(() => first, ResilienceError, "Operation timed out");
  assertEquals(await queued, 2);

  // The abandoned holder settles late; its slot was already released, so it must not free another.
  firstHold.resolve();
  await delay(0);
  const third = operation();
  const fourth = operation();
  await assertRejects(() => operation(), ResilienceError, "Bulkhead queue is full");
  thirdHold.resolve();
  assertEquals(await Promise.all([third, fourth]), [3, 4]);
  assertEquals(started, [1, 2, 3, 4]);
});

Deno.test("withResilience enforces an operation timeout", async () => {
  const operation = withResilience(
    () => new Promise<string>(() => undefined),
    { timeoutMs: 1 },
  );
  await assertRejects(() => operation(), ResilienceError, "Operation timed out");
});

Deno.test("timeouts count as circuit breaker failures", async () => {
  const operation = withResilience(
    () => new Promise<string>(() => undefined),
    { timeoutMs: 10, circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 1000 } },
  );
  await assertRejects(() => operation(), ResilienceError, "Operation timed out");
  await assertRejects(() => operation(), ResilienceError, "Operation timed out");
  await assertRejects(() => operation(), ResilienceError, "Circuit breaker is open");
});

Deno.test("a hung half-open probe does not wedge the breaker", async () => {
  let calls = 0;
  const operation = withResilience(
    (): Promise<string> => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("down"));
      if (calls === 2) return new Promise<string>(() => undefined);
      return Promise.resolve("ok");
    },
    { timeoutMs: 10, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 20 } },
  );
  await assertRejects(() => operation(), Error, "down");
  await delay(30);
  await assertRejects(() => operation(), ResilienceError, "Operation timed out");
  await delay(30);
  assertEquals(await operation(), "ok");
});

Deno.test("a timed-out operation releases its bulkhead slot", async () => {
  let calls = 0;
  const operation = withResilience(
    (): Promise<string> => {
      calls += 1;
      if (calls === 1) return new Promise<string>(() => undefined);
      return Promise.resolve("ok");
    },
    { timeoutMs: 10, bulkhead: { maxConcurrent: 1 } },
  );
  await assertRejects(() => operation(), ResilienceError, "Operation timed out");
  assertEquals(await operation(), "ok");
});

Deno.test("withResilience rejects invalid policy budgets early", () => {
  assertThrows(
    () => withResilience(async () => "ok", { bulkhead: { maxConcurrent: 1, queueSize: -1 } }),
    Error,
    "queueSize",
  );
  assertThrows(
    () =>
      withResilience(async () => "ok", {
        retry: { maxAttempts: 1, initialDelayMs: -1 },
      }),
    Error,
    "initialDelayMs",
  );
  assertThrows(
    () => withResilience(async () => "ok", { timeoutMs: 2_147_483_648 }),
    Error,
    "timeoutMs",
  );
});

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
