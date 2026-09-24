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
    throw new AggregateError([a, b], "nested");
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
