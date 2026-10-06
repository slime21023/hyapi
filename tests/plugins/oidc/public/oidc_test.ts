import { assertEquals } from "@std/assert";
import { createApplication, requireScopes } from "@hyapi/core";
import { oidcBearer } from "@hyapi/plugin-oidc";
import { exportJWK, generateKeyPair, SignJWT } from "npm:jose@6";

const ISSUER = "https://issuer.example.com/";
const AUDIENCE = "orders-api";
const JWKS_URL = "https://issuer.example.com/.well-known/jwks.json";

Deno.test("the public OIDC plugin verifies remote JWKS bearer tokens", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "active", alg: "RS256", use: "sig" };
  const originalFetch = globalThis.fetch;
  let jwksRequests = 0;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === JWKS_URL) {
      jwksRequests += 1;
      return Promise.resolve(Response.json({ keys: [jwk] }));
    }
    return originalFetch(input, init);
  };

  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createApplication({
      config: { name: "oidc-plugin" },
      modules: [{
        name: "private",
        setup(module) {
          module.route({
            method: "get",
            path: "/private",
            guards: [
              oidcBearer({
                issuer: ISSUER,
                audience: AUDIENCE,
                jwksUrl: JWKS_URL,
                algorithms: ["RS256"],
              }),
              requireScopes("orders:read"),
            ],
            handler: ({ identity, ok }) => ok({ subject: identity?.subject }),
          });
        },
      }],
    });

    const anonymous = await app.request("http://test/private");
    assertEquals(anonymous.status, 401);
    assertEquals(anonymous.headers.get("www-authenticate"), "Bearer");

    const valid = await app.request("http://test/private", {
      headers: { authorization: `Bearer ${await accessToken(privateKey)}` },
    });
    assertEquals(valid.status, 200);
    assertEquals(await valid.json(), { subject: "ada" });
    assertEquals(jwksRequests, 1);

    const rejected = await Promise.all([
      app.request("http://test/private", {
        headers: {
          authorization: `Bearer ${await accessToken(privateKey, {
            issuer: "https://other.example.com/",
          })}`,
        },
      }),
      app.request("http://test/private", {
        headers: {
          authorization: `Bearer ${await accessToken(privateKey, { audience: "other-api" })}`,
        },
      }),
      app.request("http://test/private", {
        headers: {
          authorization: `Bearer ${await accessToken(privateKey, {
            expiration: Math.floor(Date.now() / 1000) - 1,
          })}`,
        },
      }),
      app.request("http://test/private", { headers: { authorization: "Token malformed" } }),
    ]);
    for (const response of rejected) assertEquals(response.status, 401);
    const firstRejected = rejected[0];
    if (firstRejected === undefined) throw new Error("Expected an invalid OIDC response.");
    assertEquals((await firstRejected.json()).detail, "Authentication is required.");

    const { privateKey: untrustedKey } = await generateKeyPair("RS256");
    const invalidSignature = await app.request("http://test/private", {
      headers: { authorization: `Bearer ${await accessToken(untrustedKey)}` },
    });
    assertEquals(invalidSignature.status, 401);
  } finally {
    await app?.close();
    globalThis.fetch = originalFetch;
  }
});

interface AccessTokenOptions {
  readonly issuer?: string;
  readonly audience?: string;
  readonly expiration?: string | number;
}

function accessToken(privateKey: CryptoKey, options: AccessTokenOptions = {}): Promise<string> {
  return new SignJWT({ scope: "orders:read" })
    .setProtectedHeader({ alg: "RS256", kid: "active" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject("ada")
    .setIssuedAt()
    .setExpirationTime(options.expiration ?? "1h")
    .sign(privateKey);
}
