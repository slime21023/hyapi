# Optional HTTP Plugins

HyAPI applications expose `app.fetch`, a standard `Request` to `Response` handler. Optional HTTP
packages wrap that boundary; they do not extend the Core lifecycle Plugin API or import Core
internals.

`@hyapi/plugin-cors` and `@hyapi/plugin-rate-limit` are part of this candidate checkout and are not
yet published to JSR.

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
