# Plugins

HyAPI has no middleware. A plugin is one of two things:

- a **security verifier** for a scheme: `@hyapi/plugin-jwt` and `@hyapi/plugin-oidc`, described in
  [Security](./security); or
- an **outer `fetch` wrapper** of the form `(fetch, options) => fetch`, composed around `app.fetch`:
  `@hyapi/plugin-cors`, `@hyapi/plugin-csrf`, and `@hyapi/plugin-rate-limit`.

Wrappers answer errors with the same problem shape as the runtime. Compose them and pass the result
to `serve`:

```ts
const handler = withCors(
  withRateLimit(app.fetch, { limit: 600, windowMs: 60_000, key: clientKey }),
  { origins: ["https://app.example.com"] },
);
serve(app, { fetch: handler });
```

## CORS

```ts
import { withCors } from "@hyapi/plugin-cors";

withCors(app.fetch, {
  origins: ["https://app.example.com"], // or a predicate; ["*"] only without credentials
  credentials: true,
  allowHeaders: ["content-type", "authorization", "x-csrf-token"],
  exposeHeaders: ["location"],
  maxAgeSeconds: 600,
});
```

Origins are always explicit. Preflight from an allowed origin answers 204; preflight from another
origin, or for undeclared methods or headers, answers 403. Other requests reach the app, and CORS
headers are added only for allowed origins.

## CSRF

For browser clients authenticated by cookies, `withCsrf` implements a signed double-submit check:

```ts
import { withCsrf } from "@hyapi/plugin-csrf";

withCsrf(app.fetch, {
  secret: Deno.env.get("CSRF_SECRET")!, // at least 32 bytes
  skip: (request) => request.headers.get("authorization")?.startsWith("Bearer ") ?? false,
});
```

Safe requests receive a `__Host-csrf` cookie holding a signed token. The browser's script echoes it
in the `x-csrf-token` header on unsafe requests; a missing, mismatched, or forged token answers 403
`CSRF_FAILED`. Bearer-token APIs do not need CSRF protection; use `skip` for them.

## Rate limiting

```ts
import { withRateLimit } from "@hyapi/plugin-rate-limit";

withRateLimit(app.fetch, {
  limit: 100,
  windowMs: 60_000,
  key: (request) => request.headers.get("x-api-key") ?? undefined,
});
```

A fixed window per key, kept in this process. A `Request` does not reveal the client address, so
`key` is required; requests without a key are not limited. Responses carry `RateLimit-Limit`,
`RateLimit-Remaining`, and `RateLimit-Reset`, and rejected requests answer 429 `RATE_LIMITED` with
`Retry-After`. For limits across several instances, rate limit at the edge.
