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
  `await jwtBearer({ algorithm, key, issuer?, audience?, clockToleranceSeconds?, requiredClaims?, identity?, scopes? })`
  returns a verifier for bearer-based schemes.
  - It is built on [jose](https://jsr.io/@panva/jose) and accepts exactly one of `HS256` (a secret
    of at least 32 bytes), `RS256`, `ES256`, or `EdDSA` (a `CryptoKey`, JWK, or SPKI PEM).
  - `exp` is required by default.
  - Scopes come from `scope` or `scp`.
  - The factory is async, so key and option errors surface at startup.
  - Invalid tokens yield `null`.

## Open questions

- Whether a typed client (a later goal) becomes a package of its own under the same rules.
