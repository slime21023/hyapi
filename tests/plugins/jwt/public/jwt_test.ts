import { assertEquals, assertRejects } from "@std/assert";
import {
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from "jsr:@panva/jose@^6";
import Type from "typebox";
import { createApp, implement } from "@hyapi/core";
import { defineApi, defineContract, defineSecurity, httpBearer } from "@hyapi/core/contract";
import { jwtBearer } from "@hyapi/plugin-jwt";

const secret = "a-very-long-test-secret-of-32-bytes!";
const audience = "test-api";
const verifierContext = {
  signal: new AbortController().signal,
  request: new Request("http://test"),
  operationId: "op",
};

async function hs256(claims: JWTPayload, key = secret, expiresIn: string | number = "1h") {
  return await new SignJWT({ aud: audience, ...claims }).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt().setExpirationTime(expiresIn).sign(new TextEncoder().encode(key));
}

Deno.test("HS256: accepts valid tokens and reads scopes", async () => {
  const verify = await jwtBearer({ audience, algorithm: "HS256", key: secret });
  const result = await verify(await hs256({ sub: "u1", scope: "a b" }), verifierContext);
  assertEquals(result?.identity.sub, "u1");
  assertEquals(result?.scopes, ["a", "b"]);
  const scp = await verify(await hs256({ sub: "u2", scp: ["x", 1, "y"] }), verifierContext);
  assertEquals(scp?.scopes, ["x", "y"]);
});

Deno.test("HS256: rejects wrong secrets, expired tokens, and missing exp", async () => {
  const verify = await jwtBearer({ audience, algorithm: "HS256", key: secret });
  assertEquals(
    await verify(
      await hs256({ sub: "u" }, "another-secret-that-is-32-bytes-long"),
      verifierContext,
    ),
    null,
  );
  assertEquals(
    await verify(
      await hs256({ sub: "u" }, secret, Math.floor(Date.now() / 1000) - 10),
      verifierContext,
    ),
    null,
  );
  const noExp = await new SignJWT({ sub: "u", aud: audience }).setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(secret));
  assertEquals(await verify(noExp, verifierContext), null);
  assertEquals(await verify("not.a.jwt", verifierContext), null);
});

Deno.test("clock tolerance accepts slightly expired tokens", async () => {
  const verify = await jwtBearer({
    audience,
    algorithm: "HS256",
    key: secret,
    clockToleranceSeconds: 60,
  });
  const token = await hs256({ sub: "u" }, secret, Math.floor(Date.now() / 1000) - 10);
  assertEquals((await verify(token, verifierContext))?.identity.sub, "u");
});

Deno.test("issuer and audience are enforced", async () => {
  const verify = await jwtBearer({
    algorithm: "HS256",
    key: secret,
    issuer: "https://auth.example.com",
    audience: ["orders", "billing"],
  });
  const good = await hs256({ sub: "u", iss: "https://auth.example.com", aud: "billing" });
  const badIss = await hs256({ sub: "u", iss: "https://evil.example.com", aud: "billing" });
  const badAud = await hs256({ sub: "u", iss: "https://auth.example.com", aud: "other" });
  assertEquals((await verify(good, verifierContext))?.identity.sub, "u");
  assertEquals(await verify(badIss, verifierContext), null);
  assertEquals(await verify(badAud, verifierContext), null);
});

Deno.test("only the configured algorithm is accepted", async () => {
  const { publicKey } = await generateKeyPair("ES256");
  const verify = await jwtBearer({ audience, algorithm: "ES256", key: publicKey });
  // An HS256 token must never verify against an asymmetric configuration.
  assertEquals(await verify(await hs256({ sub: "u" }), verifierContext), null);
});

Deno.test("ES256 with an SPKI PEM key, EdDSA with a JWK, RS256 with a CryptoKey", async () => {
  for (const algorithm of ["ES256", "EdDSA", "RS256"] as const) {
    const { publicKey, privateKey } = await generateKeyPair(algorithm, { extractable: true });
    const key = algorithm === "ES256"
      ? await exportSPKI(publicKey)
      : algorithm === "EdDSA"
      ? await exportJWK(publicKey)
      : publicKey;
    const verify = await jwtBearer({ audience, algorithm, key });
    const token = await new SignJWT({ sub: algorithm, aud: audience })
      .setProtectedHeader({ alg: algorithm })
      .setExpirationTime("1h").sign(privateKey);
    assertEquals((await verify(token, verifierContext))?.identity.sub, algorithm);
  }
});

Deno.test("identity mapping can reject tokens", async () => {
  const verify = await jwtBearer({
    audience,
    algorithm: "HS256",
    key: secret,
    identity: (claims) => (claims.sub === "blocked" ? null : { subject: claims.sub ?? "" }),
    scopes: () => ["fixed"],
  });
  assertEquals(await verify(await hs256({ sub: "u" }), verifierContext), {
    identity: { subject: "u" },
    scopes: ["fixed"],
  });
  assertEquals(await verify(await hs256({ sub: "blocked" }), verifierContext), null);
});

Deno.test("configuration errors surface when the verifier is created", async () => {
  await assertRejects(() => jwtBearer({ audience, algorithm: "HS256", key: "short" }), RangeError);
  await assertRejects(
    () => jwtBearer({ audience, algorithm: "ES256", key: new Uint8Array(32) }),
    TypeError,
  );
  await assertRejects(() => jwtBearer({ audience, algorithm: "ES256", key: "not a pem" }));
  await assertRejects(
    () => jwtBearer({ audience, algorithm: "HS256", key: secret, clockToleranceSeconds: -1 }),
    RangeError,
  );
  await assertRejects(
    () => jwtBearer({ audience, algorithm: "none" as never, key: secret }),
    TypeError,
  );
  for (const missing of [undefined, "", []]) {
    await assertRejects(
      () => jwtBearer({ algorithm: "HS256", key: secret, audience: missing as never }),
      TypeError,
    );
  }
});

Deno.test("works as an httpBearer verifier in createApp", async () => {
  const security = defineSecurity({
    bearer: httpBearer<{ subject: string }>({ bearerFormat: "JWT" }),
  });
  const contract = defineContract({
    securitySchemes: security,
    operations: {
      me: {
        method: "GET",
        path: "/me",
        security: [{ bearer: ["profile"] }],
        responses: { 200: Type.Object({ subject: Type.String() }) },
      },
    },
  });
  const app = await createApp({
    api: defineApi({
      info: { title: "JWT", version: "1" },
      securitySchemes: security,
      contracts: [contract],
    }),
    implementations: [
      implement(contract, {
        me: (_input, { security: identities }) => ({
          status: 200,
          body: { subject: identities.bearer.subject },
        }),
      }),
    ],
    verifiers: {
      bearer: await jwtBearer({
        audience,
        algorithm: "HS256",
        key: secret,
        identity: (claims) => (claims.sub ? { subject: claims.sub } : null),
      }),
    },
  });
  const get = async (token?: string) => {
    const response = await app.fetch(
      new Request("http://test/me", token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    );
    return { status: response.status, body: await response.json() };
  };
  assertEquals(await get(await hs256({ sub: "ada", scope: "profile" })), {
    status: 200,
    body: { subject: "ada" },
  });
  assertEquals((await get(await hs256({ sub: "ada" }))).status, 403);
  assertEquals((await get("garbage")).status, 401);
  assertEquals((await get()).status, 401);
});
