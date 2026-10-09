import { assert, assertEquals, assertThrows } from "@std/assert";
import { withCsrf } from "@hyapi/plugin-csrf";

const secret = "a-csrf-secret-that-is-32-bytes-long!";
const inner = () => new Response("ok");

async function tokenFrom(handler: (r: Request) => Promise<Response> | Response): Promise<string> {
  const response = await handler(new Request("http://app/"));
  await response.body?.cancel();
  const cookie = response.headers.get("set-cookie")!;
  return cookie.split(";")[0]!.split("=").slice(1).join("=");
}

const post = (headers: Record<string, string>) =>
  new Request("http://app/items", { method: "POST", headers });

Deno.test("safe requests receive a signed token cookie once", async () => {
  const handler = withCsrf(inner, { secret });
  const response = await handler(new Request("http://app/"));
  const cookie = response.headers.get("set-cookie")!;
  assert(cookie.startsWith("__Host-csrf="));
  assert(cookie.includes("Path=/") && cookie.includes("SameSite=Lax") && cookie.includes("Secure"));
  assert(!cookie.includes("HttpOnly"), "the browser's script must read it");
  await response.body?.cancel();
  const token = cookie.split(";")[0]!.split("=")[1]!;
  const again = await handler(
    new Request("http://app/", { headers: { cookie: `__Host-csrf=${token}` } }),
  );
  assertEquals(again.headers.get("set-cookie"), null, "a valid token is not reissued");
  await again.body?.cancel();
});

Deno.test("unsafe requests need the cookie's token echoed in the header", async () => {
  const handler = withCsrf(inner, { secret });
  const token = await tokenFrom(handler);
  const ok = await handler(post({ cookie: `__Host-csrf=${token}`, "x-csrf-token": token }));
  assertEquals([ok.status, await ok.text()], [200, "ok"]);
  for (
    const headers of [
      {},
      { cookie: `__Host-csrf=${token}` },
      { "x-csrf-token": token },
      { cookie: `__Host-csrf=${token}`, "x-csrf-token": "other" },
    ]
  ) {
    const response = await handler(post(headers));
    assertEquals(response.status, 403, JSON.stringify(headers));
    assertEquals((await response.json()).code, "CSRF_FAILED");
  }
});

Deno.test("forged and foreign tokens are rejected", async () => {
  const handler = withCsrf(inner, { secret });
  const foreign = await tokenFrom(
    withCsrf(inner, { secret: "another-secret-that-is-32-bytes-long" }),
  );
  const forged = "AAAA.BBBB";
  for (const token of [foreign, forged, "no-dot", "a.b.c"]) {
    const response = await handler(post({ cookie: `__Host-csrf=${token}`, "x-csrf-token": token }));
    assertEquals(response.status, 403, token);
    await response.body?.cancel();
  }
});

Deno.test("skip bypasses the check, and options are validated", async () => {
  const handler = withCsrf(inner, {
    secret,
    cookieName: "csrf",
    secure: false,
    skip: (r) => r.headers.get("authorization")?.startsWith("Bearer ") ?? false,
  });
  assertEquals((await handler(post({ authorization: "Bearer t" }))).status, 200);
  const token = await tokenFrom(handler);
  const cookieless = await handler(post({ cookie: `csrf=${token}`, "x-csrf-token": token }));
  assertEquals(cookieless.status, 200);
  assertThrows(() => withCsrf(inner, { secret: "short" }), RangeError);
  assertThrows(() => withCsrf(inner, { secret, secure: false }), TypeError);
});

Deno.test("CORS preflight passes through without a token or a cookie", async () => {
  const handler = withCsrf(inner, { secret });
  const response = await handler(
    new Request("http://app/items", {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com", "access-control-request-method": "POST" },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("set-cookie"), null);
  await response.body?.cancel();
});
