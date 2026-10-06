import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type AppConfig,
  ConfigurationError,
  createApplication,
  type Guard,
  type Identity,
  type RequestState,
  UnauthorizedError,
} from "@hyapi/core";
import { jwtBearer } from "@hyapi/plugin-jwt";

const VALID_SECRET = "this-is-a-very-secure-secret-key-32-chars";
const SHORT_SECRET = "short-secret";
const AUTHENTICATION_REQUIRED = "Authentication is required.";

function testState(): RequestState {
  const values = new Map<unknown, unknown>();
  return {
    get: (key) => values.get(key) as never,
    require: (key) => values.get(key) as never,
    set: (key, value) => void values.set(key, value),
    has: (key) => values.has(key),
  };
}

/** Runs a guard outside an application, as a route would before input parsing. */
async function authenticate(guard: Guard, request: Request): Promise<Identity | void> {
  return await guard.check({
    request,
    requestId: "test",
    params: {},
    query: {},
    identity: null,
    state: testState(),
    signal: new AbortController().signal,
    deadline: Date.now() + 1_000,
  });
}

function encodeBase64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function signTestToken(
  headerPart: string,
  payloadPart: string,
  secret: string = VALID_SECRET,
): Promise<string> {
  const data = `${headerPart}.${payloadPart}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const binary = String.fromCharCode(...new Uint8Array(signature));
  const signaturePart = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

  return `${data}.${signaturePart}`;
}

function createTestToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  secret: string = VALID_SECRET,
): Promise<string> {
  return signTestToken(
    encodeBase64Url(JSON.stringify(header)),
    encodeBase64Url(JSON.stringify(payload)),
    secret,
  );
}

function createRawTestToken(
  header: Record<string, unknown>,
  payload: string,
  secret: string = VALID_SECRET,
): Promise<string> {
  return signTestToken(encodeBase64Url(JSON.stringify(header)), encodeBase64Url(payload), secret);
}

Deno.test("jwtBearer - rejects secrets shorter than 32 bytes", () => {
  assertThrows(
    () => jwtBearer({ secret: SHORT_SECRET }),
    ConfigurationError,
    "JWT secret must contain at least 32 bytes.",
  );
});

Deno.test("jwtBearer - rejects negative or non-finite clock skew", () => {
  for (const clockSkewSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertThrows(
      () => jwtBearer({ secret: VALID_SECRET, clockSkewSeconds }),
      ConfigurationError,
      "JWT clockSkewSeconds must be a non-negative number.",
    );
  }
});

Deno.test("jwtBearer - rejects a missing Authorization header with a Bearer challenge", async () => {
  const error = await assertRejects(
    () => authenticate(jwtBearer({ secret: VALID_SECRET }), new Request("http://test/")),
    UnauthorizedError,
  );
  assertEquals((error as UnauthorizedError).challenge, "Bearer");
});

Deno.test("jwtBearer - optional guards pass requests without an Authorization header", async () => {
  const guard = jwtBearer({ secret: VALID_SECRET, optional: true });
  assertEquals(await authenticate(guard, new Request("http://test/")), undefined);
});

Deno.test("jwtBearer - throws UnauthorizedError for non-Bearer auth headers", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });

  const basicReq = new Request("http://test/", {
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  await assertRejects(() => authenticate(provider, basicReq), UnauthorizedError);

  const emptyBearerReq = new Request("http://test/", {
    headers: { authorization: "Bearer " },
  });
  await assertRejects(() => authenticate(provider, emptyBearerReq), UnauthorizedError);
});

Deno.test("jwtBearer - throws UnauthorizedError for malformed token format", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });

  const invalidPartsReq = new Request("http://test/", {
    headers: { authorization: "Bearer header.payload" },
  });
  await assertRejects(() => authenticate(provider, invalidPartsReq), UnauthorizedError);

  const invalidJsonReq = new Request("http://test/", {
    headers: { authorization: "Bearer not_json.not_json.sig" },
  });
  await assertRejects(() => authenticate(provider, invalidJsonReq), UnauthorizedError);
});

Deno.test("jwtBearer - rejects tokens whose header or claims are not JSON objects", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });
  for (const token of ["bnVsbA.e30.AA", "e30.bnVsbA.AA", "W10.e30.AA"]) {
    await assertRejects(
      () =>
        authenticate(
          provider,
          new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
        ),
      UnauthorizedError,
      AUTHENTICATION_REQUIRED,
    );
  }
});

Deno.test("jwtBearer - rejects critical header parameters", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);
  const token = await createTestToken(
    { alg: "HS256", typ: "JWT", crit: ["exp"] },
    { sub: "user-1", exp: now + 3600 },
  );
  await assertRejects(
    () =>
      authenticate(
        provider,
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("jwtBearer - rejects tokens with algorithms other than HS256", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);

  const noneToken = await createTestToken(
    { alg: "none", typ: "JWT" },
    { sub: "user-1", exp: now + 3600 },
  );
  const noneReq = new Request("http://test/", {
    headers: { authorization: `Bearer ${noneToken}` },
  });
  await assertRejects(
    () => authenticate(provider, noneReq),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );

  const rsToken = await createTestToken(
    { alg: "RS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600 },
  );
  const rsReq = new Request("http://test/", {
    headers: { authorization: `Bearer ${rsToken}` },
  });
  await assertRejects(
    () => authenticate(provider, rsReq),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("jwtBearer - rejects tokens with invalid signature", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);

  const tokenWithDifferentSecret = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600 },
    "another-secret-key-with-at-least-32-chars",
  );
  const req = new Request("http://test/", {
    headers: { authorization: `Bearer ${tokenWithDifferentSecret}` },
  });
  await assertRejects(
    () => authenticate(provider, req),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("jwtBearer - validates exp expiration and clock skew", async () => {
  const provider = jwtBearer({
    secret: VALID_SECRET,
    clockSkewSeconds: 5,
  });
  const now = Math.floor(Date.now() / 1000);

  // Expired 10 seconds ago (beyond 5s skew)
  const expiredToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now - 10 },
  );
  const expiredReq = new Request("http://test/", {
    headers: { authorization: `Bearer ${expiredToken}` },
  });
  await assertRejects(
    () => authenticate(provider, expiredReq),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );

  // Expired 2 seconds ago (within 5s skew)
  const skewToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now - 2 },
  );
  const skewReq = new Request("http://test/", {
    headers: { authorization: `Bearer ${skewToken}` },
  });
  const identity = await authenticate(provider, skewReq);
  assertEquals(identity?.subject, "user-1");
});

Deno.test("jwtBearer - rejects tokens exactly at the skewed expiration boundary", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET, clockSkewSeconds: 5 });
  const now = Math.floor(Date.now() / 1000);
  const token = await createTestToken({ alg: "HS256", typ: "JWT" }, {
    sub: "user-1",
    exp: now - 5,
  });
  await assertRejects(
    () =>
      authenticate(
        provider,
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("jwtBearer - rejects non-finite NumericDate claims", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);
  for (
    const payload of [
      '{"sub":"user-1","exp":1e999}',
      `{"sub":"user-1","exp":${now + 3600},"nbf":-1e999}`,
    ]
  ) {
    const token = await createRawTestToken({ alg: "HS256" }, payload);
    await assertRejects(
      () =>
        authenticate(
          provider,
          new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
        ),
      UnauthorizedError,
      AUTHENTICATION_REQUIRED,
    );
  }
});

Deno.test("jwtBearer - rejects non-numeric nbf claims", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);
  const token = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600, nbf: "soon" },
  );
  await assertRejects(
    () =>
      authenticate(
        provider,
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("jwtBearer - rejects padded compact JWT parts", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);
  const header = `${encodeBase64Url(JSON.stringify({ alg: "HS256", x: "a" }))}==`;
  const claims = encodeBase64Url(JSON.stringify({ sub: "user-1", exp: now + 3600 }));
  const token = await signTestToken(header, claims);

  await assertRejects(
    () =>
      authenticate(
        provider,
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("jwtBearer - validates nbf not-before claim", async () => {
  const provider = jwtBearer({
    secret: VALID_SECRET,
    clockSkewSeconds: 2,
  });
  const now = Math.floor(Date.now() / 1000);

  // Future token (starts 60s in future)
  const futureToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600, nbf: now + 60 },
  );
  const futureReq = new Request("http://test/", {
    headers: { authorization: `Bearer ${futureToken}` },
  });
  await assertRejects(
    () => authenticate(provider, futureReq),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("jwtBearer - validates issuer and audience", async () => {
  const provider = jwtBearer({
    secret: VALID_SECRET,
    issuer: "https://auth.example.com",
    audience: "api.example.com",
  });
  const now = Math.floor(Date.now() / 1000);

  // Wrong issuer
  const badIssToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600, iss: "wrong-iss", aud: "api.example.com" },
  );
  await assertRejects(
    () =>
      authenticate(
        provider,
        new Request("http://test/", { headers: { authorization: `Bearer ${badIssToken}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );

  // Wrong audience
  const badAudToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600, iss: "https://auth.example.com", aud: "other-aud" },
  );
  await assertRejects(
    () =>
      authenticate(
        provider,
        new Request("http://test/", { headers: { authorization: `Bearer ${badAudToken}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );

  // Valid with array audience
  const arrayAudToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    {
      sub: "user-1",
      exp: now + 3600,
      iss: "https://auth.example.com",
      aud: ["api.example.com", "other.example.com"],
    },
  );
  const identity = await authenticate(
    provider,
    new Request("http://test/", { headers: { authorization: `Bearer ${arrayAudToken}` } }),
  );
  assertEquals(identity?.subject, "user-1");
});

Deno.test("jwtBearer - rejects audience arrays with non-string values", async () => {
  const provider = jwtBearer({
    secret: VALID_SECRET,
    audience: "api.example.com",
  });
  const now = Math.floor(Date.now() / 1000);
  const token = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600, aud: ["api.example.com", 42] },
  );

  await assertRejects(
    () =>
      authenticate(
        provider,
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("jwtBearer - extracts scopes from string and array claims", async () => {
  const provider = jwtBearer({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);

  // Space-separated scope string
  const strScopeToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600, scope: "read write admin" },
  );
  const id1 = await authenticate(
    provider,
    new Request("http://test/", { headers: { authorization: `Bearer ${strScopeToken}` } }),
  );
  assertEquals(id1?.scopes, ["read", "write", "admin"]);

  // Array scopes
  const arrScopeToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-2", exp: now + 3600, scopes: ["users:read", "users:write"] },
  );
  const id2 = await authenticate(
    provider,
    new Request("http://test/", { headers: { authorization: `Bearer ${arrScopeToken}` } }),
  );
  assertEquals(id2?.scopes, ["users:read", "users:write"]);
});

Deno.test("jwtBearer - protects routes and exposes verified claims", async () => {
  const config: AppConfig = {
    name: "jwt-plugin-test",
    version: "1.0.0",
    environment: "test",
    requestIdHeader: "x-request-id",
    openapi: {
      enabled: true,
      defaultDocument: "default",
      documents: [{ id: "default", title: "Test", version: "1.0.0", path: "/openapi.json" }],
    },
  };
  const app = await createApplication({
    config,
    modules: [{
      name: "private",
      setup(module) {
        module.route({
          method: "get",
          path: "/private",
          guards: [jwtBearer({ secret: VALID_SECRET })],
          handler: ({ identity, ok }) => ok({ tenant: identity?.claims.tenant }),
        });
      },
    }],
  });

  const response = await app.request("http://test/private");
  assertEquals(response.status, 401);
  assertEquals(response.headers.get("www-authenticate"), "Bearer");

  const malformedResponse = await app.request("http://test/private", {
    headers: { authorization: "Bearer not-a-jwt" },
  });
  assertEquals(malformedResponse.status, 401);
  assertEquals(malformedResponse.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
  assertEquals((await malformedResponse.json()).detail, AUTHENTICATION_REQUIRED);

  const token = await createTestToken({ alg: "HS256" }, {
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 60,
    tenant: "acme",
  });
  const allowed = await app.request("http://test/private", {
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals(await allowed.json(), { tenant: "acme" });

  const document = await (await app.request("http://test/openapi.json")).json();
  assertEquals(document.components.securitySchemes, {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  });
  assertEquals(document.paths["/private"].get.security, [{ bearerAuth: [] }]);
  await app.close();
});
