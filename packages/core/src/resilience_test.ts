import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ResilienceError, withResilience } from "../mod.ts";

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

Deno.test("circuit breakers ignore client-classified failures", async () => {
  class ClientError extends Error {
    readonly reason = "client" as const;
  }
  let attempts = 0;
  const operation = withResilience(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new ClientError("bad request");
      throw new Error("down");
    },
    { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 1000 } },
  );

  await assertRejects(() => operation(), ClientError);
  await assertRejects(() => operation(), Error, "down");
  await assertRejects(() => operation(), ResilienceError, "Circuit breaker is open");
  assertEquals(attempts, 2);
});

Deno.test("withResilience enforces an operation timeout", async () => {
  const operation = withResilience(
    () => new Promise<string>(() => undefined),
    { timeoutMs: 1 },
  );
  await assertRejects(() => operation(), ResilienceError, "Operation timed out");
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
});
