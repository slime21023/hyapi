# Security

Security is declared in the contract and enforced by the runtime, so the emitted document and the
behavior always agree. The application supplies one **verifier** per scheme.

## Schemes and requirements

```ts
export const security = defineSecurity({
  bearer: httpBearer<{ subject: string }>({ bearerFormat: "JWT" }),
  partner: apiKey<{ partner: string }>({ in: "header", name: "x-api-key" }),
});
```

An operation's `security` lists alternatives; each alternative lists schemes that must all pass:

```ts
security: [{ bearer: ["orders:read"] }, { partner: [] }]; // bearer with a scope, OR a partner key
security: [{ bearer: [], partner: [] }]; // both
security: []; // public
```

Scheme names are type-checked. Scopes are checked against OAuth 2 flows by `checkContracts`.

Security fails closed. Once the API declares a scheme, every operation needs a requirement from
itself, its contract, or the API; an operation with none fails startup (`implicit-public`). Write
`security: []` to make an operation public on purpose.

### Credentials set by a proxy

An `apiKey` header scheme can carry an identity that a proxy established, such as a client
certificate checked by mTLS:

```ts
mtls: apiKey<{ subject: string }>({ in: "header", name: "x-client-subject" }),
```

The verifier trusts whatever value arrives, so this is safe only when every request passes the
proxy, and the proxy removes the header from client requests before setting it. Otherwise a client
can send the header itself.

## Verifiers

```ts
import type { Verifier } from "@hyapi/core";

const partner: Verifier<typeof security, "partner"> = async (key, ctx) => {
  const record = await partners.find(key, { signal: ctx.signal });
  return record ? { identity: { partner: record.name }, scopes: record.scopes } : null;
};

const app = await createApp({ api, implementations, verifiers: { bearer, partner } });
```

A verifier receives the credential and `{ signal, request, operationId }`:

| Scheme                                  | Credential                                                    |
| --------------------------------------- | ------------------------------------------------------------- |
| `httpBearer`, `oauth2`, `openIdConnect` | The token from `Authorization: Bearer <token>`                |
| `httpBasic`                             | `{ username, password }`, decoded from `Authorization: Basic` |
| `apiKey`                                | The value of the declared header, query parameter, or cookie  |

It returns `{ identity, scopes? }` for a valid credential and `null` for an invalid one. Throwing
means the verifier itself failed, for example because a key server is down, and answers 500 rather
than pretending the caller is unauthenticated.

## Evaluation

- Security runs before input validation, so unauthenticated callers learn nothing about schemas.
- Alternatives are tried in order; the first satisfied one wins and becomes `ctx.security`.
- Schemes within an alternative are verified in order, stopping at the first failure.
- Each scheme is verified at most once per request, and verifiers share the request timeout.
- A credential that verifies but lacks a required scope answers **403**
  (`WWW-Authenticate: Bearer error="insufficient_scope"` for bearer schemes). Anything else answers
  **401** with `Bearer` and `Basic realm="<API title>"` challenges.

## JWT and OpenID Connect

`@hyapi/plugin-jwt` verifies JWTs with a static key:

```ts
import { jwtBearer } from "@hyapi/plugin-jwt";

const bearer = await jwtBearer({
  algorithm: "ES256", // or HS256 (secret of at least 32 bytes), RS256, EdDSA
  key: Deno.env.get("JWT_PUBLIC_KEY")!, // SPKI PEM, JWK, or CryptoKey
  issuer: "https://auth.example.com",
  audience: "orders",
  identity: (claims) => (claims.sub ? { subject: claims.sub } : null),
});
```

`@hyapi/plugin-oidc` discovers the issuer's keys and follows key rotation:

```ts
import { oidcBearer } from "@hyapi/plugin-oidc";

const oidc = await oidcBearer({
  issuer: "https://id.example.com",
  audience: "orders",
  identity: (claims) => (claims.sub ? { subject: claims.sub } : null),
});
```

Both accept exactly the configured algorithms, require an `audience` and the `exp` claim, read
scopes from `scope` or `scp`, and fail at startup on bad keys or an unreachable issuer. When the
identity provider's key server fails at runtime, `oidcBearer` throws, which answers 500, not 401.
