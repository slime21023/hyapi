import { assertEquals } from "@std/assert";
import { withRateLimit } from "@hyapi/plugin-rate-limit";

function key(request: Request): string {
  return request.headers.get("x-client-id") ?? "anonymous";
}

Deno.test("the public rate-limit wrapper limits one explicit key and reports its budget", async () => {
  const handler = withRateLimit(() => new Response("ok"), {
    limit: 2,
    windowMs: 1_000,
    key,
  });
  const request = () =>
    new Request("http://api.example.com/users", {
      headers: { "x-client-id": "client-a" },
    });

  const first = await handler(request());
  assertEquals(first.status, 200);
  assertEquals(first.headers.get("ratelimit-limit"), "2");
  assertEquals(first.headers.get("ratelimit-remaining"), "1");

  const second = await handler(request());
  assertEquals(second.status, 200);
  assertEquals(second.headers.get("ratelimit-remaining"), "0");

  const rejected = await handler(request());
  assertEquals(rejected.status, 429);
  assertEquals(rejected.headers.get("content-type"), "application/problem+json");
  assertEquals(rejected.headers.has("retry-after"), true);
  assertEquals(await rejected.json(), {
    type: "about:blank",
    title: "Too Many Requests",
    status: 429,
    code: "RATE_LIMITED",
  });
});

Deno.test("the public rate-limit wrapper keeps keys separate and bounds stored keys", async () => {
  const handler = withRateLimit(() => new Response("ok"), {
    limit: 1,
    windowMs: 1_000,
    key,
    maxKeys: 1,
  });
  const request = (client: string) =>
    new Request("http://api.example.com/users", {
      headers: { "x-client-id": client },
    });

  assertEquals((await handler(request("client-a"))).status, 200);
  assertEquals((await handler(request("client-b"))).status, 429);
});

Deno.test("the public rate-limit wrapper starts a new fixed window", async () => {
  const handler = withRateLimit(() => new Response("ok"), {
    limit: 1,
    windowMs: 40,
    key,
  });
  const request = () =>
    new Request("http://api.example.com/users", {
      headers: { "x-client-id": "client-a" },
    });

  assertEquals((await handler(request())).status, 200);
  assertEquals((await handler(request())).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals((await handler(request())).status, 200);
});
