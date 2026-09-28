import { assertEquals, assertThrows } from "@std/assert";
import { withCors } from "@hyapi/plugin-cors";

const cors = {
  origins: ["https://app.example.com", /^https:\/\/preview-[a-z]+\.example\.com$/g],
  methods: ["GET", "POST"],
  headers: ["content-type"],
  exposeHeaders: ["x-request-id"],
  maxAgeSeconds: 600,
} as const;

Deno.test("the public CORS wrapper permits literal and regular-expression origins", async () => {
  const handler = withCors(
    () =>
      new Response("ok", {
        headers: {
          "access-control-allow-origin": "https://incorrect.example.com",
          "x-request-id": "request-1",
        },
      }),
    cors,
  );

  for (const origin of ["https://app.example.com", "https://preview-blue.example.com"]) {
    const response = await handler(
      new Request("http://api.example.com/users", { headers: { origin } }),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("access-control-allow-origin"), origin);
    assertEquals(response.headers.get("access-control-expose-headers"), "x-request-id");
    assertEquals(response.headers.get("vary"), "origin");
  }

  const denied = await handler(
    new Request("http://api.example.com/users", {
      headers: { origin: "https://untrusted.example.com" },
    }),
  );
  assertEquals(denied.headers.get("access-control-allow-origin"), null);
});

Deno.test("the public CORS wrapper completes accepted preflight requests", async () => {
  const handler = withCors(() => new Response("unreachable"), cors);
  const response = await handler(
    new Request("http://api.example.com/users", {
      method: "OPTIONS",
      headers: {
        origin: "https://preview-blue.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(response.headers.get("access-control-allow-methods"), "GET, POST");
  assertEquals(response.headers.get("access-control-allow-headers"), "content-type");
  assertEquals(response.headers.get("access-control-max-age"), "600");
  assertEquals(
    response.headers.get("vary"),
    "origin, access-control-request-method, access-control-request-headers",
  );
});

Deno.test("the public CORS wrapper supports non-credentialed wildcard origins", async () => {
  const handler = withCors(() => new Response("ok"), { origins: "*", methods: ["GET"] });
  const response = await handler(
    new Request("http://api.example.com/users", {
      headers: { origin: "https://anywhere.example" },
    }),
  );

  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(response.headers.get("vary"), null);
  assertThrows(
    () => withCors(() => new Response(), { origins: "*", methods: ["GET"], credentials: true }),
    TypeError,
  );
});
