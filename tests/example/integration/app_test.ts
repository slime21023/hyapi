import { assert, assertEquals } from "@std/assert";
import { defineConfig } from "@hyapi/core";
import { buildExampleApp } from "../../../apps/example/src/app.ts";

const config = defineConfig({ name: "example-test", environment: "test" });
const secret = "test-secret-with-at-least-32-characters";

Deno.test("example application composes Users and Orders through a public port", async () => {
  const app = await buildExampleApp(config, secret, { enableRequestLogging: false });

  const live = await app.request("http://test/health/live");
  assertEquals(live.status, 200);
  assertEquals((await live.json()).status, "ok");

  const missingAuth = await app.request("http://test/v1/users");
  assertEquals(missingAuth.status, 401);

  const readToken = await createToken(secret, ["users:read"]);
  const writeToken = await createToken(secret, ["users:write"]);
  const bothToken = await createToken(secret, ["users:read", "users:write"]);
  const orderToken = await createToken(secret, ["orders:write"]);

  const readList = await app.request("http://test/v1/users", {
    headers: { authorization: `Bearer ${readToken}` },
  });
  assertEquals(readList.status, 200);

  const forbidden = await app.request("http://test/v1/users", {
    method: "POST",
    headers: {
      authorization: `Bearer ${readToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "No Write Scope", email: "readonly@example.com" }),
  });
  assertEquals(forbidden.status, 403);

  const malformedToken = await app.request("http://test/v1/users", {
    headers: { authorization: "Bearer not-a-jwt" },
  });
  assertEquals(malformedToken.status, 401);

  const invalidBase64SigToken = await app.request("http://test/v1/users", {
    headers: {
      authorization:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.invalid!sig!@#$",
    },
  });
  assertEquals(invalidBase64SigToken.status, 401);

  const expiredToken = await createToken(secret, ["users:read"], -10);
  const expired = await app.request("http://test/v1/users", {
    headers: { authorization: `Bearer ${expiredToken}` },
  });
  assertEquals(expired.status, 401);

  const created = await app.request("http://test/v1/users", {
    method: "POST",
    headers: {
      authorization: `Bearer ${writeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Ada Lovelace", email: "ada@example.com" }),
  });
  assertEquals(created.status, 201);
  const user = await created.json();
  assert(typeof user.id === "string");

  const order = await app.request("http://test/v1/orders", {
    method: "POST",
    headers: {
      authorization: `Bearer ${orderToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ userId: user.id, sku: "starter-plan" }),
  });
  assertEquals(order.status, 201);
  assertEquals((await order.json()).userId, user.id);

  const missingOrderOwner = await app.request("http://test/v1/orders", {
    method: "POST",
    headers: {
      authorization: `Bearer ${orderToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ userId: crypto.randomUUID(), sku: "starter-plan" }),
  });
  assertEquals(missingOrderOwner.status, 404);

  const duplicate = await app.request("http://test/v1/users", {
    method: "POST",
    headers: {
      authorization: `Bearer ${writeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Ada Again", email: "ada@example.com" }),
  });
  assertEquals(duplicate.status, 409);

  const invalid = await app.request("http://test/v1/users", {
    method: "POST",
    headers: {
      authorization: `Bearer ${writeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "", email: "invalid" }),
  });
  assertEquals(invalid.status, 400);

  const list = await app.request("http://test/v1/users", {
    headers: { authorization: `Bearer ${bothToken}` },
  });
  assertEquals(list.status, 200);
  const listJson = await list.json();
  assertEquals(listJson.total, 1);
  assertEquals(listJson.data.length, 1);
  assertEquals(listJson.data[0].name, "Ada Lovelace");

  const updated = await app.request(`http://test/v1/users/${user.id}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${writeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "ada.new@example.com" }),
  });
  assertEquals(updated.status, 200);
  const updatedUser = await updated.json();
  assertEquals(updatedUser.email, "ada.new@example.com");

  const deleted = await app.request(`http://test/v1/users/${user.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${writeToken}` },
  });
  assertEquals(deleted.status, 204);

  const openapi = await app.request("http://test/openapi.json");
  assertEquals(openapi.status, 200);
  const document = await openapi.json();
  assertEquals(document.openapi, "3.1.0");
  assertEquals(document.info.path, undefined);
  assert(document.paths["/v1/users"]);
  assert(document.paths["/v1/orders"]);
  assertEquals(document.paths["/v1/users"].get.security, [{ bearerAuth: ["users:read"] }]);
  assertEquals(document.paths["/v1/users"].post.security, [{ bearerAuth: ["users:write"] }]);
  assertEquals(document.paths["/v1/orders"].post.security, [{ bearerAuth: ["orders:write"] }]);
  assert(document.paths["/v1/users"].get.responses["401"]);
  assert(document.paths["/v1/users"].get.responses["403"]);
  assert(document.paths["/v1/users/{id}"].delete.responses["204"]);
  assert(document.components.securitySchemes.bearerAuth);
  assert(document.components.schemas.ProblemDetails);
});

Deno.test("example readiness probe reports ready when providers are healthy", async () => {
  const app = await buildExampleApp(config, secret, { enableRequestLogging: false });

  const ready = await app.request("http://test/health/ready");
  assertEquals(ready.status, 200);
  const body = await ready.json();
  assertEquals(body.status, "ready");
  assertEquals(body.service, "example-test");

  await app.close();
});

Deno.test("example users can be fetched by id until they are deleted", async () => {
  const app = await buildExampleApp(config, secret, { enableRequestLogging: false });
  const token = await createToken(secret, ["users:read", "users:write"]);
  const authorization = `Bearer ${token}`;

  const created = await app.request("http://test/v1/users", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ name: "Grace Hopper", email: "grace@example.com" }),
  });
  assertEquals(created.status, 201);
  const user = await created.json();

  const found = await app.request(`http://test/v1/users/${user.id}`, {
    headers: { authorization },
  });
  assertEquals(found.status, 200);
  assertEquals((await found.json()).email, "grace@example.com");

  const deleted = await app.request(`http://test/v1/users/${user.id}`, {
    method: "DELETE",
    headers: { authorization },
  });
  assertEquals(deleted.status, 204);

  const missing = await app.request(`http://test/v1/users/${user.id}`, {
    headers: { authorization },
  });
  assertEquals(missing.status, 404);
  await missing.body?.cancel();

  await app.close();
});

Deno.test("example orders require the orders:write scope", async () => {
  const app = await buildExampleApp(config, secret, { enableRequestLogging: false });
  const payload = JSON.stringify({ userId: crypto.randomUUID(), sku: "starter-plan" });

  const anonymous = await app.request("http://test/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  assertEquals(anonymous.status, 401);
  await anonymous.body?.cancel();

  const readToken = await createToken(secret, ["users:read"]);
  const forbidden = await app.request("http://test/v1/orders", {
    method: "POST",
    headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
    body: payload,
  });
  assertEquals(forbidden.status, 403);
  await forbidden.body?.cancel();

  await app.close();
});

Deno.test("example user updates and deletes return 404 for unknown ids", async () => {
  const app = await buildExampleApp(config, secret, { enableRequestLogging: false });
  const token = await createToken(secret, ["users:write"]);
  const unknownId = crypto.randomUUID();

  const patched = await app.request(`http://test/v1/users/${unknownId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Nobody" }),
  });
  assertEquals(patched.status, 404);
  await patched.body?.cancel();

  const deleted = await app.request(`http://test/v1/users/${unknownId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals(deleted.status, 404);
  await deleted.body?.cancel();

  await app.close();
});

async function createToken(
  secretValue: string,
  scopes: readonly string[],
  ttlSeconds = 300,
): Promise<string> {
  const encode = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ alg: "HS256", typ: "JWT" });
  const claims = encode({
    sub: "test-user",
    scope: scopes.join(" "),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
