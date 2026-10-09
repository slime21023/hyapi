import { assertEquals, assertThrows } from "@std/assert";
import { withRateLimit } from "@hyapi/plugin-rate-limit";

const inner = () => new Response("ok");
const request = (key?: string) =>
  new Request("http://api/", key ? { headers: { "x-api-key": key } } : {});
const key = (r: Request) => r.headers.get("x-api-key") ?? undefined;

Deno.test("allows the limit, then answers 429 with limit headers", async () => {
  const handler = withRateLimit(inner, { limit: 2, windowMs: 60_000, key });
  const first = await handler(request("a"));
  assertEquals([first.status, first.headers.get("ratelimit-remaining")], [200, "1"]);
  assertEquals(first.headers.get("ratelimit-limit"), "2");
  await first.body?.cancel();
  await (await handler(request("a"))).body?.cancel();
  const limited = await handler(request("a"));
  assertEquals(limited.status, 429);
  assertEquals((await limited.json()).code, "RATE_LIMITED");
  assertEquals(limited.headers.get("ratelimit-remaining"), "0");
  assertEquals(limited.headers.get("retry-after"), "60");
});

Deno.test("keys are counted separately, and unkeyed requests are not limited", async () => {
  const handler = withRateLimit(inner, { limit: 1, windowMs: 60_000, key });
  assertEquals((await handler(request("a"))).status, 200);
  assertEquals((await handler(request("b"))).status, 200);
  assertEquals((await handler(request("a"))).status, 429);
  for (let i = 0; i < 3; i++) {
    const response = await handler(request());
    assertEquals([response.status, response.headers.get("ratelimit-limit")], [200, null]);
  }
});

Deno.test("a new window starts after windowMs", async () => {
  const handler = withRateLimit(inner, { limit: 1, windowMs: 50, key });
  assertEquals((await handler(request("a"))).status, 200);
  assertEquals((await handler(request("a"))).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assertEquals((await handler(request("a"))).status, 200);
});

Deno.test("tracked keys are bounded", async () => {
  const handler = withRateLimit(inner, { limit: 1, windowMs: 60_000, key, maxKeys: 2 });
  for (const k of ["a", "b", "c"]) assertEquals((await handler(request(k))).status, 200);
  // "a" was dropped to make room, so it starts a new window.
  assertEquals((await handler(request("a"))).status, 200);
  assertEquals((await handler(request("c"))).status, 429);
});

Deno.test("options are validated", () => {
  assertThrows(() => withRateLimit(inner, { limit: 0, windowMs: 1, key }), RangeError);
  assertThrows(() => withRateLimit(inner, { limit: 1, windowMs: 1.5, key }), RangeError);
});
