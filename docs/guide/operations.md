# Operations

## Serving

```ts
import { serve } from "@hyapi/core/deno";

const server = serve(app, { port: 8000 });
await server.finished;
```

Run with `--unstable-no-legacy-abort`:

```sh
deno run --allow-net --allow-env --unstable-no-legacy-abort src/main.ts
```

Without the flag, Deno aborts every request's signal after a successful response, which handlers
would observe as a client disconnect.

`serve` shuts down gracefully on SIGINT and SIGTERM (SIGINT and SIGBREAK on Windows), or when its
`signal` option aborts. Its options are `port`, `hostname`, `signals`, `signal`,
`shutdownTimeoutMs`, `onListen`, and `fetch`. Use `fetch` to serve a handler with outer wrappers
while `serve` still closes the app:

```ts
serve(app, { fetch: withCors(app.fetch, { origins: ["https://app.example.com"] }) });
```

## Shutdown

`app.close()`, which `serve` calls, runs these steps:

1. new requests get 503 `SHUTTING_DOWN`;
2. in-flight requests drain within `shutdownTimeoutMs`;
3. the remaining requests are aborted through `ctx.signal` and answer 503; and
4. lifecycle resources stop in reverse order, within one shared budget.

`serve` forces the remaining connections closed after its own `shutdownTimeoutMs` (30 seconds by
default). Keep it above the app's budget, and the platform's termination grace period above both.

## Lifecycle resources

```ts
const app = await createApp({
  api,
  implementations,
  lifecycle: [
    { name: "database", start: () => pool.connect(), stop: (signal) => pool.end({ signal }) },
    { name: "cache", start: () => cache.connect(), stop: () => cache.quit() },
  ],
});
```

Resources start in order before `createApp` returns. If one fails, the started ones stop in reverse
order and the original error is thrown. On close, they stop in reverse order, and a failing or slow
resource does not prevent the others from stopping.

## Health

```ts
import { createHealth } from "@hyapi/core";

const health = createHealth({ database: (signal) => pool.ping({ signal }) }, { timeoutMs: 2000 });
```

A check that resolves is healthy, one that returns `{ status: "degraded", detail }` is degraded, and
one that throws or times out is unhealthy. Pass `health` to `createApp`, and the report turns
`unhealthy` with `draining: true` as soon as shutdown starts, so load balancers stop sending
traffic. Expose it through a declared operation; `HealthReport` is the schema:

```ts
health: {
  method: "GET",
  path: "/health",
  security: [],
  responses: { 200: HealthReport, 503: HealthReport },
},
```

```ts
health: async () => {
  const report = await health.check();
  return report.status === "unhealthy"
    ? { status: 503, body: report }
    : { status: 200, body: report };
},
```

## Events

`createApp({ onEvent })` receives read-only events:

| Event                              | When                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `operation.start`, `operation.end` | Around every matched request, with status, duration, problem `code`, thrown error, and the `deprecated` flag |
| `response.violation`               | A response does not match its schema                                                                         |
| `response.stripped`                | Development only: undeclared fields were removed                                                             |
| `startup.warning`                  | A contract warning, such as an unnamed schema                                                                |
| `lifecycle.error`                  | A resource failed to start or stop                                                                           |

Listeners cannot change requests or responses, and their errors are contained. Without a listener,
problem events are written with `console.warn`. See [Observability](../recipes/observability).

`operation.end` events of deprecated operations show who still calls them before you remove them.

## Serving the document

```ts
import document from "../openapi.json" with { type: "json" };

const app = await createApp({
  api,
  implementations,
  document: { path: "/openapi.json", content: document },
});
```

The path must not collide with a declared route.

## Behind a proxy

Keep TLS, compression, request logging at the edge, and global rate limits in the reverse proxy.
Align the proxy's body limit with `bodyLimitBytes`, and its timeouts with `requestTimeoutMs`.
