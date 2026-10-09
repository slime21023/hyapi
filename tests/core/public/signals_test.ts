// Regression test for a leak found by the HTTP load baseline: request signals must not stay
// attached to the application's long-lived shutdown signal once their request is done.
import { assert } from "@std/assert";
import Type from "typebox";
import { createApp, implement } from "@hyapi/core";
import { defineApi, defineContract } from "@hyapi/core/contract";

const T = Type;
const contract = defineContract({
  operations: {
    plain: { method: "GET", path: "/plain", responses: { 200: T.Object({ ok: T.Boolean() }) } },
    stream: {
      method: "GET",
      path: "/stream",
      responses: { 200: { description: "A stream", body: T.String(), mediaType: "text/plain" } },
    },
    slow: {
      method: "GET",
      path: "/slow",
      responses: { 200: T.Object({ ok: T.Boolean() }) },
    },
  },
});

Deno.test("finished requests leave no listeners on any signal", async () => {
  // Count listeners added minus removed, per signal.
  const net = new Map<EventTarget, number>();
  const add = AbortSignal.prototype.addEventListener;
  const remove = AbortSignal.prototype.removeEventListener;
  // Deno keeps a signal from AbortSignal.any reachable from its sources, so a composite of the
  // shutdown signal leaks about 1 KB per request without any listener showing it.
  const any = AbortSignal.any;
  let anyCalls = 0;
  AbortSignal.any = (signals) => {
    anyCalls++;
    return any.call(AbortSignal, signals);
  };
  AbortSignal.prototype.addEventListener = function (...args: Parameters<typeof add>) {
    net.set(this, (net.get(this) ?? 0) + 1);
    return add.apply(this, args);
  };
  AbortSignal.prototype.removeEventListener = function (...args: Parameters<typeof remove>) {
    net.set(this, (net.get(this) ?? 0) - 1);
    return remove.apply(this, args);
  };
  try {
    const app = await createApp({
      api: defineApi({ info: { title: "Signals", version: "1" }, contracts: [contract] }),
      onEvent: () => {},
      timeouts: { slow: 5 },
      implementations: [
        implement(contract, {
          plain: () => ({ status: 200, body: { ok: true } }),
          stream: () => new Response(new Blob(["streamed"]).stream()),
          slow: (_, ctx) =>
            new Promise((_resolve, reject) => {
              ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
            }),
        }),
      ],
    });
    for (let i = 0; i < 100; i++) {
      for (const path of ["/plain", "/stream", "/slow"]) {
        await (await app.fetch(new Request(`http://t${path}`))).text();
      }
    }
    // Per-request signals end with a few listeners each; only a long-lived signal could grow.
    const largest = Math.max(...net.values());
    assert(largest < 10, `a signal accumulated ${largest} listeners over 300 requests`);
    assert(anyCalls === 0, "the request path must not use AbortSignal.any");
    await app.close();
  } finally {
    AbortSignal.prototype.addEventListener = add;
    AbortSignal.prototype.removeEventListener = remove;
    AbortSignal.any = any;
  }
});
