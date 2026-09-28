import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { withCsrf } from "@hyapi/plugin-csrf";

const options = {
  origins: ["https://app.example.com"],
  secret: "this-example-secret-has-at-least-thirty-two-bytes",
  cookie: { name: "hyapi-csrf", secure: false },
} as const;

Deno.test("the public CSRF wrapper issues and accepts signed double-submit tokens", async () => {
  const handler = withCsrf(
    () => new Response("ok", { status: 201, headers: { "x-handler": "called" } }),
    options,
  );

  const initial = await handler(new Request("http://api.example.com/profile"));
  assertEquals(initial.status, 201);
  assertEquals(initial.headers.get("x-handler"), "called");
  const token = readCsrfToken(initial.headers);
  assertMatch(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const accepted = await handler(
    new Request("http://api.example.com/profile", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        cookie: `hyapi-csrf=${token}`,
        "x-csrf-token": token,
      },
    }),
  );
  assertEquals(accepted.status, 201);
  assertEquals(accepted.headers.get("x-handler"), "called");
});

Deno.test("the public CSRF wrapper rejects missing, forged, and untrusted unsafe requests", async () => {
  const handler = withCsrf(() => new Response("unreachable"), options);
  const requests = [
    new Request("http://api.example.com/profile", { method: "POST" }),
    new Request("http://api.example.com/profile", {
      method: "POST",
      headers: { origin: "https://untrusted.example.com" },
    }),
    new Request("http://api.example.com/profile", {
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        cookie: "hyapi-csrf=forged.signature",
        "x-csrf-token": "forged.signature",
      },
    }),
  ];

  for (const request of requests) {
    const response = await handler(request);
    assertEquals(response.status, 403);
    assertEquals(await response.json(), {
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      code: "CSRF_REJECTED",
      detail: "CSRF validation failed.",
    });
  }
});

Deno.test("the public CSRF wrapper keeps secure cookie defaults explicit", () => {
  assertThrows(
    () => withCsrf(() => new Response(), { ...options, cookie: { secure: false } }),
    TypeError,
  );
  assertThrows(
    () => withCsrf(() => new Response(), { ...options, origins: ["*"] }),
    TypeError,
  );
});

function readCsrfToken(headers: Headers): string {
  const cookie = headers.getSetCookie().find((value) => value.startsWith("hyapi-csrf="));
  if (cookie === undefined) throw new Error("Expected CSRF token cookie.");
  const token = /^hyapi-csrf=([^;]+)/.exec(cookie)?.[1];
  if (token === undefined) throw new Error("Expected CSRF token value.");
  return token;
}
