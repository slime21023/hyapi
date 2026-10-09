// The canonical wrapper order documented in the plugins guide:
// withCors(withCsrf(withRateLimit(app.fetch))). CORS is outermost, so every answer that the
// inner wrappers or the app produce carries CORS headers, and preflight never reaches them.
import { assert, assertEquals } from "@std/assert";
import Type from "typebox";
import { createApp, implement } from "@hyapi/core";
import { defineApi, defineContract } from "@hyapi/core/contract";
import { withCors } from "@hyapi/plugin-cors";
import { withCsrf } from "@hyapi/plugin-csrf";
import { withRateLimit } from "@hyapi/plugin-rate-limit";

const origin = "https://app.example.com";
const items = defineContract({
  operations: {
    listItems: {
      method: "GET",
      path: "/items",
      responses: { 200: Type.Object({ ok: Type.Boolean() }) },
    },
    createItem: {
      method: "POST",
      path: "/items",
      responses: { 201: Type.Object({ ok: Type.Boolean() }) },
    },
  },
});

async function canonical() {
  const app = await createApp({
    api: defineApi({ info: { title: "Composition", version: "1" }, contracts: [items] }),
    onEvent: () => {},
    implementations: [
      implement(items, {
        listItems: () => ({ status: 200, body: { ok: true } }),
        createItem: () => ({ status: 201, body: { ok: true } }),
      }),
    ],
  });
  const fetch = withCors(
    withCsrf(
      withRateLimit(app.fetch, { limit: 2, windowMs: 60_000, key: () => "client" }),
      { secret: "a-csrf-secret-that-is-32-bytes-long!", cookieName: "csrf", secure: false },
    ),
    {
      origins: [origin],
      credentials: true,
      allowHeaders: ["content-type", "x-csrf-token"],
      exposeHeaders: ["retry-after"],
    },
  );
  return { app, fetch };
}

const request = (method: string, headers: Record<string, string> = {}) =>
  new Request("http://api/items", { method, headers: { origin, ...headers } });

Deno.test("the canonical order answers preflight without CSRF cookies or rate limiting", async () => {
  const { app, fetch } = await canonical();
  for (let i = 0; i < 3; i++) {
    const response = await fetch(
      request("OPTIONS", {
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-csrf-token",
      }),
    );
    assertEquals(response.status, 204);
    assertEquals(response.headers.get("set-cookie"), null);
    assertEquals(response.headers.get("ratelimit-limit"), null);
  }
  await app.close();
});

Deno.test("CSRF and rate-limit failures carry CORS headers, so browsers can read them", async () => {
  const { app, fetch } = await canonical();
  const forged = await fetch(request("POST"));
  assertEquals([forged.status, (await forged.json()).code], [403, "CSRF_FAILED"]);
  assertEquals(forged.headers.get("access-control-allow-origin"), origin);

  let limited: Response | undefined;
  for (let i = 0; i < 3; i++) {
    const response = await fetch(request("GET"));
    if (response.status === 429) limited = response;
    else await response.body?.cancel();
  }
  assert(limited !== undefined, "the third request is limited");
  assertEquals(limited.headers.get("access-control-allow-origin"), origin);
  assertEquals(limited.headers.get("access-control-expose-headers"), "retry-after");
  assert(limited.headers.get("retry-after") !== null);
  await limited.body?.cancel();
  await app.close();
});
