import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import { AppError } from "./errors.ts";
import { Scope } from "./scope.ts";

Deno.test("Scope closes resources once in reverse registration order", async () => {
  const closed: string[] = [];
  const scope = new Scope("closing failed");
  scope.defer(() => void closed.push("first"));
  scope.defer(() => void closed.push("second"));
  await scope.adopt({ close: () => void closed.push("adopted") });

  const first = scope.close();
  assertStrictEquals(scope.close(), first);
  await first;
  assertEquals(closed, ["adopted", "second", "first"]);
  assertEquals(scope.state, "closed");
});

Deno.test("Scope.close is once-only when a closer reenters close", async () => {
  const scope = new Scope("closing failed");
  const calls: string[] = [];
  let invocations = 0;
  let reentered: Promise<void> | undefined;
  scope.defer(() => void calls.push("first"));
  scope.defer(() => {
    calls.push("last");
    if (++invocations === 1) {
      reentered = scope.close(Date.now() + 100);
      return reentered;
    }
  });

  const closing = scope.close(Date.now() + 100);
  await closing;
  assertStrictEquals(reentered, closing);
  assertStrictEquals(scope.close(), closing);
  assertEquals(calls, ["last", "first"]);
});

Deno.test("Scope runs every closer and reports a flat AggregateError", async () => {
  const a = new Error("a");
  const b = new Error("b");
  const c = new Error("c");
  let ran = false;
  const scope = new Scope("closing failed");
  scope.defer(() => {
    ran = true;
  });
  scope.defer(() => {
    throw new AggregateError([new AggregateError([a], "inner"), b], "nested");
  });
  scope.defer(() => {
    throw c;
  });

  const error = await assertRejects(() => scope.close(), AggregateError, "closing failed");
  assertEquals(error.errors, [c, a, b]);
  assertEquals(ran, true);
});

Deno.test("Scope rejects registrations after it closes", async () => {
  const scope = new Scope("closing failed");
  await scope.close();

  const error = assertThrows(() => scope.defer(() => undefined), AppError);
  assertEquals(error.code, "SCOPE_CLOSED");

  let closed = false;
  const adopted = await assertRejects(
    () => scope.adopt({ close: () => void (closed = true) }),
    AppError,
  );
  assertEquals(adopted.code, "SCOPE_CLOSED");
  assertEquals(closed, true);
});

Deno.test("Scope deadline bounds async cleanup and still invokes later closers", async () => {
  const calls: string[] = [];
  const pending = Promise.withResolvers<void>();
  const scope = new Scope("closing failed");
  scope.defer(() => {
    calls.push("last");
  });
  scope.defer(() => {
    calls.push("stalled");
    return pending.promise;
  });
  scope.defer(() => {
    calls.push("throws");
    throw new Error("sync failure");
  });
  const error = await assertRejects(() => scope.close(Date.now() + 15), AggregateError);
  assertEquals(calls, ["throws", "stalled", "last"]);
  assertEquals(error.errors.map((item: Error) => [item.name, item.message]), [
    ["Error", "sync failure"],
    ["TimeoutError", "Resource cleanup timed out."],
  ]);
  assertStrictEquals(scope.close(), scope.close(Date.now() + 100));
  pending.reject(new Error("late failure"));
  await new Promise((resolve) => setTimeout(resolve, 1));
});
