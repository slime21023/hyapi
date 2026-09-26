import { assert, assertRejects, assertStrictEquals } from "@std/assert";
import { sleep } from "../../../../packages/core/src/runtime/timers.ts";

Deno.test("sleep rejects with the abort reason as soon as the signal aborts", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  setTimeout(() => controller.abort(reason), 10);
  const started = Date.now();
  const error = await assertRejects(() => sleep(1000, controller.signal));
  assertStrictEquals(error, reason);
  assert(Date.now() - started < 50);
});

Deno.test("sleep rejects immediately for an already aborted signal", async () => {
  const reason = new Error("already");
  const error = await assertRejects(() => sleep(1000, AbortSignal.abort(reason)));
  assertStrictEquals(error, reason);
});
