# Optional Packages

Optional packages do not expand Core. They use one of the public extension boundaries:

- HTTP wrappers receive an `app.fetch` handler and return a standard `Request` to `Response`
  handler.
- Guard packages export `Guard` factories that routes and groups attach with `guards`.
- Application plugins use the narrow Core `Plugin` API to add global lifecycle hooks.

`@hyapi/plugin-cors`, `@hyapi/plugin-rate-limit`, `@hyapi/plugin-jwt`, `@hyapi/plugin-oidc`, and
`@hyapi/plugin-csrf` are part of this candidate checkout and are not yet published to JSR.

```ts
import { createApplication } from "@hyapi/core";
import { withCors } from "@hyapi/plugin-cors";
import { withRateLimit } from "@hyapi/plugin-rate-limit";

const app = await createApplication({
  config: { name: "public-api" },
  modules: [],
});

const handler = withCors(
  withRateLimit(app.fetch, {
    limit: 100,
    windowMs: 60_000,
    key: (request) => request.headers.get("x-api-key") ?? "anonymous",
  }),
  {
    origins: ["https://app.example.com", /^https:\/\/preview-[a-z0-9-]+\.example\.com$/],
    methods: ["GET", "POST"],
    headers: ["content-type", "authorization"],
  },
);

Deno.serve(handler);
```

Place CORS outside the rate limiter so accepted browser preflight requests do not consume a limit
and every rate-limited response receives the configured CORS headers.

## CORS

`withCors()` handles accepted preflight requests and appends CORS headers to ordinary responses. Its
`origins` setting accepts exact origins, regular expressions, or `"*"`:

```ts
withCors(app.fetch, {
  origins: "*",
  methods: ["GET"],
});
```

Use `"*"` only for non-credentialed browser access. Credentialed CORS requires explicit literal
origins; regex and wildcard rules are rejected. Regular expressions run against the complete request
Origin value, so anchor patterns to avoid accidental partial matches.

CORS governs what browsers may read. It is not authentication or authorization: ordinary requests
from a disallowed origin still reach the application, but browsers cannot expose their response to
that origin. Use route authentication and CSRF protections where the application needs them.

## Local rate limiting

`withRateLimit()` is an in-process fixed-window limiter. It requires a `key` function because a
native `Request` has no trustworthy client-address field. Do not blindly use `X-Forwarded-For`; only
derive a key from proxy headers when the proxy is trusted and overwrites them.

The wrapper adds `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers to allowed
responses. It returns a `429 application/problem+json` response with `Retry-After` when the limit or
the configured `maxKeys` capacity is reached.

This limiter is local to one application process. It is not a distributed global limit and must not
be used as the sole traffic-control boundary for a multi-instance deployment. Use an edge service
for global traffic policy; add a separate shared-store plugin only when that integration is
required.

## HS256 JWT bearer authentication

`jwtBearer()` returns a guard that verifies HS256 Bearer tokens signed with a shared secret of at
least 32 bytes. It requires `exp`, checks `nbf`, `iss`, and `aud` when present or configured, maps
the `scope` string or `scopes` array to `identity.scopes`, and exposes all verified claims as
`identity.claims`.

```ts
import { type Module, requireScopes } from "@hyapi/core";
import { jwtBearer } from "@hyapi/plugin-jwt";

const authenticate = jwtBearer({ secret: Deno.env.get("JWT_SECRET")! });

const reportsModule: Module = {
  name: "reports",
  setup(module) {
    module.group("/reports", { guards: [authenticate] }, (reports) => {
      reports.route({
        method: "get",
        path: "",
        guards: [requireScopes("reports:read")],
        handler: ({ identity, ok }) => ok({ subject: identity?.subject }),
      });
    });
  },
};
```

Missing credentials are rejected with 401 and `www-authenticate: Bearer` unless the guard is created
with `optional: true`. Invalid credentials are always rejected with 401 and
`www-authenticate: Bearer error="invalid_token"`. The guard contributes a `bearerAuth` security
scheme to OpenAPI; set `schemeName` to choose another name.

## OIDC bearer authentication

`oidcBearer()` returns a guard that verifies Bearer access tokens from one OIDC issuer through its
remote JWKS endpoint. It maps the standard space-delimited `scope` claim to `identity.scopes` and
the verified payload to `identity.claims`.

```ts
import { requireScopes } from "@hyapi/core";
import { oidcBearer } from "@hyapi/plugin-oidc";

const authenticate = oidcBearer({
  issuer: "https://issuer.example.com/",
  audience: "orders-api",
  jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
  algorithms: ["RS256"],
});

module.group("/orders", { guards: [authenticate, requireScopes("orders:read")] }, (orders) => {
  // routes
});
```

Set the issuer, audience, JWKS URL, and accepted asymmetric algorithms explicitly. Missing and
invalid credentials follow the same 401 rules as `jwtBearer()`, including `optional`. The package
does not add login redirects, discovery, sessions, cookies, refresh tokens, user-info calls, or
retry policy.

## CSRF protection

`withCsrf()` is a signed double-submit wrapper for cookie-authenticated browser endpoints. Safe
requests receive an HMAC-signed token cookie when needed. An unsafe request must provide that same
token in the cookie and configured header, and must have an exact allowed `Origin`.

```ts
import { withCsrf } from "@hyapi/plugin-csrf";

const handler = withCsrf(app.fetch, {
  origins: ["https://app.example.com"],
  secret: Deno.env.get("CSRF_SECRET")!,
});

Deno.serve(handler);
```

Use a distinct secret of at least 32 UTF-8 bytes, kept outside source control. The default cookie is
host-only (`__Host-hyapi-csrf`), `Secure`, `Path=/`, and `SameSite=Lax`; it is deliberately readable
by browser JavaScript so it can be sent in the `x-csrf-token` header. `origins` accepts exact HTTP
or HTTPS origins only—wildcards and regular expressions are rejected. Apply this wrapper to
cookie-authenticated browser traffic; it does not create sessions and does not treat Bearer requests
as a special case.
