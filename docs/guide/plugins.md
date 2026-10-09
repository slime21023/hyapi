# Plugins

HyAPI has no middleware. A plugin is one of two things:

- a **security verifier** for a scheme: `@hyapi/plugin-jwt` and `@hyapi/plugin-oidc`, described in
  [Security](./security); or
- an **outer `fetch` wrapper** of the form `(fetch, options) => fetch`, composed around `app.fetch`:
  `@hyapi/plugin-cors`, `@hyapi/plugin-csrf`, and `@hyapi/plugin-rate-limit`.

Wrappers answer errors with the same problem shape as the runtime. Compose them in this order, and
pass the result to `serve`:

```ts
const handler = withCors(
  withCsrf(
    withRateLimit(app.fetch, { limit: 600, windowMs: 60_000, key: clientKey }),
    { secret: Deno.env.get("CSRF_SECRET")! },
  ),
  { origins: ["https://app.example.com"], credentials: true },
);
serve(app, { fetch: handler });
```

CORS goes outermost: it answers preflight requests itself, and it adds CORS headers to every other
answer, including the 403 of CSRF and the 429 of the rate limiter, which browsers could not read
otherwise. CSRF goes before rate limiting, so forged requests do not use up a client's quota.

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
headers are added only for allowed origins. Unless the origin is `*`, every response carries
`Vary: Origin`, so a shared cache never serves one origin's answer to another.

Browsers let scripts read only a few response headers. List the others in `exposeHeaders`, such as
`location` for created resources, and `retry-after` and the `ratelimit-*` headers for rate limiting.

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
`CSRF_FAILED`. CORS preflight requests pass through untouched. Bearer-token APIs do not need CSRF
protection; use `skip` for them.

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

To limit by client address behind a proxy, read the address that your proxy added. A proxy appends
the client's address to `X-Forwarded-For`, so with one trusted proxy it is the **last** entry;
earlier entries come from the client and can be forged:

```ts
key: (request) => request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim(),
```

Without a proxy that sets the header, any value in it comes from the client.
