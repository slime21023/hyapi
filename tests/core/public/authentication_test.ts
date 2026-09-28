import { assertEquals, assertRejects } from "@std/assert";
import { ConfigurationError, UnauthorizedError } from "@hyapi/core";
import { createApplication, JwtAuthProvider, jwtPlugin } from "@hyapi/core";
import { type AppConfig } from "@hyapi/core";

const VALID_SECRET = "this-is-a-very-secure-secret-key-32-chars";
const SHORT_SECRET = "short-secret";
const AUTHENTICATION_REQUIRED = "Authentication is required.";

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

Deno.test("JwtAuthProvider - rejects secrets shorter than 32 bytes", async () => {
  await assertRejects(
    () => JwtAuthProvider.create({ secret: SHORT_SECRET }),
    ConfigurationError,
    "JWT secret must contain at least 32 bytes.",
  );
});

Deno.test("JwtAuthProvider - rejects negative or non-finite clock skew", async () => {
  for (const clockSkewSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assertRejects(
      () => JwtAuthProvider.create({ secret: VALID_SECRET, clockSkewSeconds }),
      ConfigurationError,
      "JWT clockSkewSeconds must be a non-negative number.",
    );
  }
});

Deno.test("JwtAuthProvider - returns null when Authorization header is absent", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
  const req = new Request("http://test/");
  const result = await provider.authenticate(req);
  assertEquals(result, null);
});

Deno.test("JwtAuthProvider - throws UnauthorizedError for non-Bearer auth headers", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });

  const basicReq = new Request("http://test/", {
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  await assertRejects(() => provider.authenticate(basicReq), UnauthorizedError);

  const emptyBearerReq = new Request("http://test/", {
    headers: { authorization: "Bearer " },
  });
  await assertRejects(() => provider.authenticate(emptyBearerReq), UnauthorizedError);
});

Deno.test("JwtAuthProvider - throws UnauthorizedError for malformed token format", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });

  const invalidPartsReq = new Request("http://test/", {
    headers: { authorization: "Bearer header.payload" },
  });
  await assertRejects(() => provider.authenticate(invalidPartsReq), UnauthorizedError);

  const invalidJsonReq = new Request("http://test/", {
    headers: { authorization: "Bearer not_json.not_json.sig" },
  });
  await assertRejects(() => provider.authenticate(invalidJsonReq), UnauthorizedError);
});

Deno.test("JwtAuthProvider - rejects tokens whose header or claims are not JSON objects", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
  for (const token of ["bnVsbA.e30.AA", "e30.bnVsbA.AA", "W10.e30.AA"]) {
    await assertRejects(
      () =>
        provider.authenticate(
          new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
        ),
      UnauthorizedError,
      AUTHENTICATION_REQUIRED,
    );
  }
});

Deno.test("JwtAuthProvider - rejects critical header parameters", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);
  const token = await createTestToken(
    { alg: "HS256", typ: "JWT", crit: ["exp"] },
    { sub: "user-1", exp: now + 3600 },
  );
  await assertRejects(
    () =>
      provider.authenticate(
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("JwtAuthProvider - rejects tokens with algorithms other than HS256", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);

  const noneToken = await createTestToken(
    { alg: "none", typ: "JWT" },
    { sub: "user-1", exp: now + 3600 },
  );
  const noneReq = new Request("http://test/", {
    headers: { authorization: `Bearer ${noneToken}` },
  });
  await assertRejects(
    () => provider.authenticate(noneReq),
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
    () => provider.authenticate(rsReq),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("JwtAuthProvider - rejects tokens with invalid signature", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
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
    () => provider.authenticate(req),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("JwtAuthProvider - validates exp expiration and clock skew", async () => {
  const provider = await JwtAuthProvider.create({
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
    () => provider.authenticate(expiredReq),
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
  const identity = await provider.authenticate(skewReq);
  assertEquals(identity?.subject, "user-1");
});

Deno.test("JwtAuthProvider - rejects tokens exactly at the skewed expiration boundary", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET, clockSkewSeconds: 5 });
  const now = Math.floor(Date.now() / 1000);
  const token = await createTestToken({ alg: "HS256", typ: "JWT" }, {
    sub: "user-1",
    exp: now - 5,
  });
  await assertRejects(
    () =>
      provider.authenticate(
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("JwtAuthProvider - rejects non-finite NumericDate claims", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
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
        provider.authenticate(
          new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
        ),
      UnauthorizedError,
      AUTHENTICATION_REQUIRED,
    );
  }
});

Deno.test("JwtAuthProvider - rejects non-numeric nbf claims", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);
  const token = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600, nbf: "soon" },
  );
  await assertRejects(
    () =>
      provider.authenticate(
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("JwtAuthProvider - rejects padded compact JWT parts", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);
  const header = `${encodeBase64Url(JSON.stringify({ alg: "HS256", x: "a" }))}==`;
  const claims = encodeBase64Url(JSON.stringify({ sub: "user-1", exp: now + 3600 }));
  const token = await signTestToken(header, claims);

  await assertRejects(
    () =>
      provider.authenticate(
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("JwtAuthProvider - validates nbf not-before claim", async () => {
  const provider = await JwtAuthProvider.create({
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
    () => provider.authenticate(futureReq),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("JwtAuthProvider - validates issuer and audience", async () => {
  const provider = await JwtAuthProvider.create({
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
      provider.authenticate(
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
      provider.authenticate(
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
  const identity = await provider.authenticate(
    new Request("http://test/", { headers: { authorization: `Bearer ${arrayAudToken}` } }),
  );
  assertEquals(identity?.subject, "user-1");
});

Deno.test("JwtAuthProvider - rejects audience arrays with non-string values", async () => {
  const provider = await JwtAuthProvider.create({
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
      provider.authenticate(
        new Request("http://test/", { headers: { authorization: `Bearer ${token}` } }),
      ),
    UnauthorizedError,
    AUTHENTICATION_REQUIRED,
  );
});

Deno.test("JwtAuthProvider - extracts scopes from string and array claims", async () => {
  const provider = await JwtAuthProvider.create({ secret: VALID_SECRET });
  const now = Math.floor(Date.now() / 1000);

  // Space-separated scope string
  const strScopeToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-1", exp: now + 3600, scope: "read write admin" },
  );
  const id1 = await provider.authenticate(
    new Request("http://test/", { headers: { authorization: `Bearer ${strScopeToken}` } }),
  );
  assertEquals(id1?.scopes, ["read", "write", "admin"]);

  // Array scopes
  const arrScopeToken = await createTestToken(
    { alg: "HS256", typ: "JWT" },
    { sub: "user-2", exp: now + 3600, scopes: ["users:read", "users:write"] },
  );
  const id2 = await provider.authenticate(
    new Request("http://test/", { headers: { authorization: `Bearer ${arrScopeToken}` } }),
  );
  assertEquals(id2?.scopes, ["users:read", "users:write"]);
});

Deno.test("jwtPlugin - registers an auth provider through the platform API", async () => {
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
    plugins: [jwtPlugin({ secret: VALID_SECRET })],
    modules: [{
      name: "private",
      setup(module) {
        module.route({
          method: "get",
          path: "/private",
          auth: {},
          handler: ({ ok }) => ok({ ok: true }),
        });
      },
    }],
  });

  const response = await app.request("http://test/private");
  assertEquals(response.status, 401);

  const malformedResponse = await app.request("http://test/private", {
    headers: { authorization: "Bearer not-a-jwt" },
  });
  assertEquals(malformedResponse.status, 401);
  assertEquals((await malformedResponse.json()).detail, AUTHENTICATION_REQUIRED);
});
