# Component: plugins

- Package entries: `@hyapi/plugin-jwt`, `@hyapi/plugin-oidc`, `@hyapi/plugin-cors`,
  `@hyapi/plugin-csrf`, `@hyapi/plugin-rate-limit`
- Visibility: public, each package independently

## Purpose

Provide repeated, well-defined integrations without adding an extension mechanism to Core. Every
plugin takes one of two shapes that the public API already supports.

## Shapes

| Shape                 | Form                                                                | Plugins                                                                                                 |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Security verifier     | A function registered under a `securitySchemes` name in `createApp` | `plugin-jwt` (JWT for bearer schemes), `plugin-oidc` (OIDC/JWKS for `openIdConnect` and bearer schemes) |
| Outer `fetch` wrapper | `(fetch, options) => fetch`, composed around `app.fetch`            | `plugin-cors`, `plugin-csrf` (signed double-submit), `plugin-rate-limit` (single-instance, in-memory)   |

## Responsibilities

- Expose a small explicit factory with typed options and no global singleton.
- Own their dependencies, tests, documentation, and compatibility policy.
- Verifiers return identities and granted scopes in the form that [runtime](runtime.md) expects.
- Wrappers handle what happens before or after Core, such as preflight requests, headers, and
  admission. They may take an emitted OpenAPI document as an option, for example to derive the
  allowed methods.

## Boundary

- Depend on Core only through public entry points, never on `src/`.
- Cannot change requests or responses inside the runtime. Core has no middleware or plugin
  interface.
- Remain removable: Core and applications that do not select a plugin have no dependency on it.
- Distributed rate limiting, data stores, and business integrations are not plugins. They remain
  application dependencies.

## Dependencies

Public `@hyapi/core` entry points, plus each plugin's own dependencies.

## Related decisions

ADR 0001 §15; ADR 0002 §3, §4; `AGENTS.md` "Optional integrations".

## Resolved in M4

- **`@hyapi/plugin-jwt`.**
  `await jwtBearer({ algorithm, key, issuer?, audience, clockToleranceSeconds?, requiredClaims?, identity?, scopes? })`
  (`audience` is required since M9) returns a verifier for bearer-based schemes.
  - It is built on [jose](https://jsr.io/@panva/jose) and accepts exactly one of `HS256` (a secret
    of at least 32 bytes), `RS256`, `ES256`, or `EdDSA` (a `CryptoKey`, JWK, or SPKI PEM).
  - `exp` is required by default.
  - Scopes come from `scope` or `scp`.
  - The factory is async, so key and option errors surface at startup.
  - Invalid tokens yield `null`.

## Resolved in M7a

- **Problem responses.** Wrappers answer with `problemResponse` from `@hyapi/core`, which is now
  public (RFC 0001 A14), so their errors have the same RFC 9457 shape as the runtime's.
- **`@hyapi/plugin-oidc`.**
  - `await oidcBearer({ issuer, audience, algorithms?, jwksUri?, fetchTimeoutMs?, cacheMaxAgeMs?, clockToleranceSeconds?, identity?, scopes? })`.
  - The issuer's discovery document is fetched at creation, and its `issuer` must match exactly.
    Keys come from jose's remote key set, with caching and rotation.
  - `audience` is required, and only asymmetric algorithms are accepted.
  - An invalid token yields `null`. A failing key server (a non-200 answer, a timeout, or an invalid
    set) throws instead, so an identity-provider outage is a 500 and never looks like
    "unauthenticated".
- **`@hyapi/plugin-cors`.**
  - `withCors(fetch, { origins, methods?, allowHeaders?, exposeHeaders?, credentials?, maxAgeSeconds? })`.
  - `origins` is required: a list or a predicate. `["*"]` is allowed only without credentials.
  - Preflight from an allowed origin gets 204 with `Vary`. Preflight from another origin, or for an
    undeclared method or header, gets 403.
  - Other requests reach the app, and CORS headers are added only for allowed origins.
- **`@hyapi/plugin-csrf`.**
  - `withCsrf(fetch, { secret, cookieName?, headerName?, sameSite?, secure?, skip? })`, a signed
    double-submit check.
  - Safe requests receive a `__Host-csrf` cookie holding an HMAC-signed random token. The cookie is
    readable by scripts; `Secure`, `SameSite=Lax`, and `Path=/` are set.
  - Unsafe requests must echo the token in `x-csrf-token`. A missing, mismatched, or forged token
    gets 403 `CSRF_FAILED`.
  - `skip` exempts requests such as those with bearer tokens.
- **`@hyapi/plugin-rate-limit`.**
  - `withRateLimit(fetch, { limit, windowMs, key, maxKeys? })` applies a fixed window per key, in
    memory, for one instance only.
  - `key` is required, because a `Request` does not expose the client address; requests without a
    key are not limited.
  - Limited responses carry `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`. A
    rejected request gets 429 `RATE_LIMITED` with `Retry-After`.
  - Tracked keys are bounded by `maxKeys`.

## Resolved in M9

- **Canonical order.** `withCors(withCsrf(withRateLimit(app.fetch)))`, tested in
  `tests/plugins/composition/`. CORS is outermost, so every answer carries CORS headers and
  preflight never reaches the other wrappers.
- **CORS.** Unless the origin is `*`, every response carries `Vary: Origin`, including responses to
  requests without an origin or from a disallowed one.
- **CSRF.** Preflight requests pass through without a token check or a cookie.
- **JWT.** `audience` is required; without it, a token for another service with the same key would
  be accepted.
- **Proxy trust.** The guide documents that header-based identities and `X-Forwarded-For` keys are
  safe only behind a proxy that controls them, and that the last `X-Forwarded-For` entry is the one
  a single trusted proxy added.

## Open questions

- Whether a typed client (a later goal) becomes a package of its own under the same rules.
