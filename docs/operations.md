# Operating HyAPI

This guide covers deploying, observing, and splitting a HyAPI application. The reference
implementation is the example app in [`apps/example`](../apps/example).

## Deployment

### Permissions

Run the server with explicit Deno permissions:

```text
deno run --allow-net --allow-env --unstable-no-legacy-abort src/main.ts
```

- `--allow-net` is needed by the HTTP listener and by remote providers created with `provideHttp()`.
- `--allow-env` is needed to read configuration and secrets.

Use `--unstable-no-legacy-abort` with Deno 2.9+ (included in the repository's `dev`/`start` tasks).
Without it, Deno can abort the incoming `Request.signal` after a successful response, even though
the client did not disconnect. HyAPI forwards client aborts to `ctx.signal` only while the request
scope is active; deadline and shutdown aborts remain independently owned by HyAPI.

### Environment variables

The example app reads the following variables (see [`.env.example`](../.env.example)):

| Variable       | Required | Purpose                                          |
| -------------- | -------- | ------------------------------------------------ |
| `JWT_SECRET`   | Yes      | HS256 signing secret; at least 32 bytes          |
| `DENO_ENV`     | No       | `development` (default), `test`, or `production` |
| `HOST`         | No       | Listener host; defaults to `127.0.0.1`           |
| `PORT`         | No       | Listener port; defaults to `8000`                |
| `JWT_ISSUER`   | No       | Expected `iss` claim                             |
| `JWT_AUDIENCE` | No       | Expected `aud` claim                             |

`DENO_ENV` becomes `AppConfig.environment`. Use `production` in deployed environments.

### Graceful shutdown

On SIGINT/SIGTERM, start `app.close()` immediately and stop the listener after any active
transmissions complete, as in [`apps/example/src/main.ts`](../apps/example/src/main.ts).
`info.completed` observes network delivery only; request scopes still close when a `Response`
returns. Deno 2.9 can raise `BadResource` if the ServeOptions signal aborts during an already
running `server.shutdown()` with an unfinished stream. Therefore the listener defers
`server.shutdown()` until active transmissions finish; at the `2 * shutdownTimeoutMs + 1000` ms
grace deadline, it aborts ServeOptions first, then calls `server.shutdown()`. The shutdown promise
is memoized across repeated signals and normal `server.finished` completion; both application and
server errors are retained (as an `AggregateError` when both fail).

`app.close()` shuts down in this order:

1. It stops accepting requests. New requests receive 503 `APPLICATION_UNAVAILABLE`, and
   `app.health()` reports `unhealthy`, so readiness probes fail while the application drains.
2. It waits up to `shutdownTimeoutMs` (default 30000 ms) for in-flight requests, including handlers
   abandoned after a request timeout. It then aborts remaining requests through `ctx.signal` and
   waits at most `min(1000, shutdownTimeoutMs)` more for cooperative request cleanup.
3. It gives module/plugin `onClose`, singleton services, and providers a separate shared
   `shutdownTimeoutMs` cleanup budget, in reverse acquisition order. Async closers exceeding the
   budget report `TimeoutError` in the shutdown `AggregateError`; synchronous blocking work cannot
   be interrupted.

The listener's grace deadline is `2 * shutdownTimeoutMs + 1000` ms (61 seconds at defaults). Set the
orchestrator's termination grace **above 61 seconds plus external overhead**. On forced timeout, an
uncooperative handler can still run after modules/providers close; resource cleanup is best effort,
not a guarantee that such code can safely use providers.

If provider connection fails during startup, its original connect exception is first in the reported
`AggregateError`, followed by provider rollback failures and later plugin/module cleanup failures in
order. Nested cleanup aggregates are flattened; the failed provider stage remains the startup
aggregate's `cause`, with the connect exception as its own `cause`.

The ownership and error-routing decisions are recorded in
[ADR 0001](adr/0001-layered-error-scopes.md).

### Reverse proxies

- Align the proxy's request body limit with `bodyLimitBytes` (default 10 MiB). HyAPI rejects larger
  bodies with 413 `PAYLOAD_TOO_LARGE`.
- Set the proxy's read timeout slightly above `requestTimeoutMs` (default 300000 ms, 5 minutes).
  That way a slow request reaches the client as HyAPI's 503 `REQUEST_TIMEOUT` problem+json response
  instead of a proxy-generated 504.

```ts
const config = defineConfig({
  name: "orders-api",
  environment: "production",
  bodyLimitBytes: 1_048_576,
  requestTimeoutMs: 30_000,
  openapi: { enabled: false },
});
```

### Response stream ownership

HyAPI releases request services when a `Response` is returned, not when its body finishes
transmitting. A lazy `ReadableStream` must own and close its own resources in `pull`/`cancel`; it
must not access request services, singletons, providers, or `ctx.signal` after return. Example:

```ts
const payload = new TextEncoder().encode("ready\n");
return new Response(
  new ReadableStream({
    pull(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  }, { highWaterMark: 0 }),
);
```

Errors after HTTP status is committed propagate to the body consumer or Deno transport, not to
HyAPI's `onError` or a new problem+json response.

## Observability

### Request IDs

HyAPI reads the request ID from `requestIdHeader` (default `x-request-id`). An incoming value is
reused only when it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise a UUID is generated. The ID is
returned in the same response header, included in every problem+json body, and available as
`ctx.requestId` and in lifecycle hook contexts.

### Logs and metrics

Use global lifecycle hooks from a plugin to emit logs and metrics. The example app's
`request-logging` plugin in [`apps/example/src/app.ts`](../apps/example/src/app.ts) records a start
time in `onRequest` and logs a structured `request.complete` event with the request ID, method,
path, status, and duration in `onResponse`. Error responses also pass through `onResponse`, so the
same hook observes failures; use `onError` to record the underlying error.

`onError` observers are invoked group then global, in order, and each receives the failure being
reported even if another observer changed `lifecycle.error`. Each is awaited only until it settles
or the original request deadline/forced shutdown interrupts the wait. Cleanup notifications after
the request ends use the remaining original deadline. An unsettled observer promise is observed as a
background task, not allowed to indefinitely delay the selected HTTP failure; it may still run or
mutate shared lifecycle state later, so do not rely on its completion for critical cleanup.

### Propagation to downstream services

Inside a handler, build outgoing headers with `withHttpContext(ctx, "my-service")`. It forwards:

- the request ID under the application's request ID header;
- the W3C `traceparent` header when present;
- `x-hyapi-service` with the caller's service name;
- `x-hyapi-deadline` with `ctx.deadline`, the effective absolute deadline of the current request.

`ctx.deadline` is always set: it is the earlier of the upstream `x-hyapi-deadline` and the request
start time plus `requestTimeoutMs`. HTTP contract clients send the smaller of their own `deadline`
and the propagated value, so a whole call chain shares one budget. Handlers should pass `ctx.signal`
to long-running work; it is aborted when the request times out.

### Health endpoints

`app.health()` checks every provider in parallel, each with a 5-second timeout, and aggregates the
result as `healthy`, `degraded`, or `unhealthy`. The example maps it to two endpoints:

- `GET /health/live` reports that the process is serving requests and does not check providers.
- `GET /health/ready` returns 200 `{ status: "ready" }` unless `app.health()` reports `unhealthy`,
  in which case it returns 503 with `status: "unavailable"` and the provider reports. Load balancers
  should route traffic only to instances whose readiness endpoint returns 200.

## Service extraction

A module that needs an independent deployment keeps its Port and replaces only its local provider
with `provideHttp()`. Follow the [v0.5 extraction guide](migrations/v0.5.0.md) for the Users ->
Orders walkthrough, including shared HTTP contracts, idempotency, and request-context propagation.

`provideHttp()` registers the port with the HTTP contract's version, so the application's
major/minor compatibility check at startup compares the consumer's required version against the
contract that the remote service actually implements.
