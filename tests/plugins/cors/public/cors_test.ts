import { assertEquals, assertThrows } from "@std/assert";
import { withCors } from "@hyapi/plugin-cors";

const inner = (request: Request) =>
  Response.json({ path: new URL(request.url).pathname }, { headers: { "x-request-id": "r1" } });

const preflight = (origin: string, method = "POST", headers?: string) =>
  new Request("http://api/items", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      ...(headers ? { "access-control-request-headers": headers } : {}),
    },
  });

Deno.test("allowed preflight is answered with 204 and CORS headers", async () => {
  const handler = withCors(inner, {
    origins: ["https://app.example.com"],
    credentials: true,
    maxAgeSeconds: 60,
  });
  const response = await handler(
    preflight("https://app.example.com", "PATCH", "Content-Type, Authorization"),
  );
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("access-control-allow-origin"), "https://app.example.com");
  assertEquals(response.headers.get("access-control-allow-credentials"), "true");
  assertEquals(
    response.headers.get("access-control-allow-methods"),
    "GET, HEAD, POST, PUT, PATCH, DELETE",
  );
  assertEquals(response.headers.get("access-control-max-age"), "60");
  assertEquals(
    response.headers.get("vary"),
    "origin, access-control-request-method, access-control-request-headers",
  );
});

Deno.test("preflight from other origins, or for undeclared methods or headers, is refused", async () => {
  const handler = withCors(inner, { origins: ["https://app.example.com"] });
  for (
    const request of [
      preflight("https://evil.example.com"),
      preflight("https://app.example.com", "TRACE"),
      preflight("https://app.example.com", "POST", "x-custom"),
    ]
  ) {
    const response = await handler(request);
    assertEquals(response.status, 403);
    assertEquals(response.headers.get("access-control-allow-origin"), null);
    assertEquals(response.headers.get("content-type"), "application/problem+json");
    await response.body?.cancel();
  }
});

Deno.test("actual requests get CORS headers only for allowed origins", async () => {
  const handler = withCors(inner, {
    origins: (origin) => origin.endsWith(".example.com"),
    exposeHeaders: ["x-request-id"],
  });
  const allowed = await handler(
    new Request("http://api/items", { headers: { origin: "https://a.example.com" } }),
  );
  assertEquals(allowed.headers.get("access-control-allow-origin"), "https://a.example.com");
  assertEquals(allowed.headers.get("access-control-expose-headers"), "x-request-id");
  assertEquals(await allowed.json(), { path: "/items" });
  const other = await handler(
    new Request("http://api/items", { headers: { origin: "https://evil.test" } }),
  );
  assertEquals(other.headers.get("access-control-allow-origin"), null);
  await other.body?.cancel();
  const sameOrigin = await handler(new Request("http://api/items"));
  assertEquals(sameOrigin.headers.get("vary"), "origin", "the answer depends on Origin (F3.2)");
  await sameOrigin.body?.cancel();
});

Deno.test("the wildcard origin answers * and never with credentials", async () => {
  const response = await withCors(inner, { origins: ["*"] })(
    new Request("http://api/items", { headers: { origin: "https://any.test" } }),
  );
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  await response.body?.cancel();
  assertThrows(() => withCors(inner, { origins: ["*"], credentials: true }), TypeError);
  assertThrows(() => withCors(inner, { origins: [] }), TypeError);
});

Deno.test("responses vary by Origin even when no CORS headers are added", async () => {
  const handler = withCors(inner, { origins: ["https://app.example.com"] });
  for (const headers of [{}, { origin: "https://evil.example" }]) {
    const response = await handler(new Request("http://api/items", { headers }));
    assertEquals(response.headers.get("vary"), "origin");
    assertEquals(response.headers.get("access-control-allow-origin"), null);
    await response.body?.cancel();
  }
  const refused = await handler(preflight("https://evil.example"));
  assertEquals([refused.status, refused.headers.get("vary")], [403, "origin"]);
  await refused.body?.cancel();

  const open = withCors(inner, { origins: ["*"] });
  const any = await open(new Request("http://api/items"));
  assertEquals(any.headers.get("vary"), null, "a wildcard answer is the same for every origin");
  await any.body?.cancel();
});
