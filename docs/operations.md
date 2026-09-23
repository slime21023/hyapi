# Operating HyAPI

This guide covers deploying, observing, and splitting a HyAPI application. The reference
implementation is the example app in [`apps/example`](../apps/example).

## Deployment

### Permissions

Run the server with explicit Deno permissions:

```text
deno run --allow-net --allow-env src/main.ts
```

- `--allow-net` is needed by the HTTP listener and by remote providers created with `provideHttp()`.
- `--allow-env` is needed to read configuration and secrets.

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

Pass an abort signal to `Deno.serve()` and close the application after the server finishes, as in
[`apps/example/src/main.ts`](../apps/example/src/main.ts):

```ts
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => controller.abort());
}
const server = Deno.serve({ port, signal: controller.signal }, app.fetch.bind(app));
try {
  await server.finished;
} finally {
  await app.close();
}
```

`app.close()` runs module and plugin `onClose` hooks in reverse order, closes providers in reverse
registration order, and closes singleton services.

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
