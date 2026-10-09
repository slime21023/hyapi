import { assertEquals, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jsr:@panva/jose@^6";
import Type from "typebox";
import { createApp, implement } from "@hyapi/core";
import { defineApi, defineContract, defineSecurity, openIdConnect } from "@hyapi/core/contract";
import { oidcBearer } from "@hyapi/plugin-oidc";

const ctx = {
  signal: new AbortController().signal,
  request: new Request("http://test"),
  operationId: "op",
};

/** A local issuer serving discovery and JWKS; `jwksStatus` can simulate an outage. */
async function startIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const state = { jwksStatus: 200, discoveryIssuer: "" };
  let issuer = "";
  const server: Deno.HttpServer<Deno.NetAddr> = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/openid-configuration") {
      return Response.json({ issuer: state.discoveryIssuer || issuer, jwks_uri: `${issuer}/jwks` });
    }
    if (path === "/jwks") {
      return state.jwksStatus === 200
        ? Response.json({ keys: [jwk] })
        : new Response("down", { status: state.jwksStatus });
    }
    return new Response("not found", { status: 404 });
  });
  issuer = `http://127.0.0.1:${server.addr.port}`;
  const sign = (
    claims: JWTPayload,
    options: { audience?: string; issuer?: string; expires?: string } = {},
  ) =>
    new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(options.issuer ?? issuer).setAudience(options.audience ?? "orders")
      .setExpirationTime(options.expires ?? "1h").sign(privateKey);
  return { issuer, sign, state, close: () => server.shutdown() };
}

Deno.test("discovers the JWKS and verifies tokens", async () => {
  const idp = await startIssuer();
  try {
    const verify = await oidcBearer({ issuer: idp.issuer, audience: "orders" });
    const result = await verify(await idp.sign({ sub: "u1", scope: "orders:read" }), ctx);
    assertEquals([result?.identity.sub, result?.scopes], ["u1", ["orders:read"]]);
  } finally {
    await idp.close();
  }
});

Deno.test("rejects tokens for another audience or issuer, expired tokens, and garbage", async () => {
  const idp = await startIssuer();
  try {
    const verify = await oidcBearer({ issuer: idp.issuer, audience: ["orders", "billing"] });
    assertEquals(
      (await verify(await idp.sign({ sub: "u" }, { audience: "billing" }), ctx))?.identity.sub,
      "u",
    );
    assertEquals(await verify(await idp.sign({ sub: "u" }, { audience: "other" }), ctx), null);
    assertEquals(
      await verify(await idp.sign({ sub: "u" }, { issuer: "https://evil.test" }), ctx),
      null,
    );
    assertEquals(await verify(await idp.sign({ sub: "u" }, { expires: "-1m" }), ctx), null);
    assertEquals(await verify("not.a.token", ctx), null);
  } finally {
    await idp.close();
  }
});

Deno.test("an unreachable key server is an internal error, not an invalid token", async () => {
  const idp = await startIssuer();
  try {
    const verify = await oidcBearer({ issuer: idp.issuer, audience: "orders" });
    const token = await idp.sign({ sub: "u" });
    idp.state.jwksStatus = 503;
    await assertRejects(() => verify(token, ctx));
  } finally {
    await idp.close();
  }
});

Deno.test("discovery problems fail when the verifier is created", async () => {
  const idp = await startIssuer();
  try {
    idp.state.discoveryIssuer = "https://other.test";
    await assertRejects(
      () => oidcBearer({ issuer: idp.issuer, audience: "orders" }),
      Error,
      "does not match",
    );
    await assertRejects(() => oidcBearer({ issuer: "not-a-url", audience: "orders" }), TypeError);
    await assertRejects(
      () => oidcBearer({ issuer: idp.issuer, audience: "orders", algorithms: ["HS256" as never] }),
      TypeError,
    );
  } finally {
    await idp.close();
  }
});

Deno.test("works as an openIdConnect verifier in createApp", async () => {
  const idp = await startIssuer();
  try {
    const security = defineSecurity({
      oidc: openIdConnect<{ subject: string }>({
        url: `${idp.issuer}/.well-known/openid-configuration`,
      }),
    });
    const contract = defineContract({
      securitySchemes: security,
      operations: {
        me: {
          method: "GET",
          path: "/me",
          security: [{ oidc: [] }],
          responses: { 200: Type.Object({ subject: Type.String() }) },
        },
      },
    });
    const app = await createApp({
      api: defineApi({
        info: { title: "OIDC", version: "1" },
        securitySchemes: security,
        contracts: [contract],
      }),
      implementations: [
        implement(contract, {
          me: (_input, { security: identities }) => ({
            status: 200,
            body: { subject: identities.oidc.subject },
          }),
        }),
      ],
      verifiers: {
        oidc: await oidcBearer({
          issuer: idp.issuer,
          audience: "orders",
          identity: (claims) => (claims.sub ? { subject: claims.sub } : null),
        }),
      },
    });
    const response = await app.fetch(
      new Request("http://test/me", {
        headers: { authorization: `Bearer ${await idp.sign({ sub: "ada" })}` },
      }),
    );
    assertEquals([response.status, await response.json()], [200, { subject: "ada" }]);
    const anonymous = await app.fetch(new Request("http://test/me"));
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();
    await app.close();
  } finally {
    await idp.close();
  }
});
