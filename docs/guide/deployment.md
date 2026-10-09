# Deployment

A HyAPI application is a `fetch(request)` handler plus a `close()` that drains requests and stops
resources. Deploying it means giving it a listener, permissions, and enough time to shut down.

## Checklist

- **Permissions.** `--allow-net` for the listener and outgoing calls, `--allow-env` for
  configuration, and `--allow-read` only for files the application reads.
- **Request signals.** Turn on `no-legacy-abort` (see [Operations](./operations#serving)), so that
  `ctx.signal` reports real client disconnects.
- **Address.** Listen on `0.0.0.0` in containers, and take the port from the environment.
- **Limits in one direction.** The proxy's body limit should match `bodyLimitBytes`, and the proxy's
  upstream timeout should be longer than `requestTimeoutMs`, so that clients get HyAPI's problem
  responses rather than a proxy error.
- **Shutdown budgets, from inside out.** The app's `shutdownTimeoutMs` (10 s by default) must be
  shorter than `serve`'s (30 s by default), which must be shorter than the platform's grace period.

## Containers

```dockerfile
FROM denoland/deno:2.9.7
WORKDIR /app
COPY . .
RUN deno install --entrypoint src/main.ts
USER deno
EXPOSE 8000
CMD ["run", "--allow-net", "--allow-env", "src/main.ts"]
```

```ts
// src/main.ts
const server = serve(app, {
  hostname: "0.0.0.0",
  port: Number(Deno.env.get("PORT") ?? 8000),
});
await server.finished;
```

The official image runs Deno under `tini`, which passes `SIGTERM` on to the process, and `serve`
shuts down gracefully when it arrives. Docker waits 10 seconds by default before it kills the
container. Give it more than `serve`'s budget, for example `docker run --stop-timeout 40` or
`stop_grace_period: 40s` in Compose.

## Kubernetes

```yaml
spec:
  terminationGracePeriodSeconds: 45
  containers:
    - name: api
      readinessProbe:
        httpGet: { path: /health, port: 8000 }
      livenessProbe:
        tcpSocket: { port: 8000 }
      lifecycle:
        preStop:
          exec: { command: ["sleep", "5"] }
```

- **Readiness** uses the health operation. It answers 503 when a check is unhealthy, and so does
  every request once `close()` has started.
- **Liveness** should not depend on databases or other services: a slow dependency must not restart
  healthy pods. A TCP probe, or an operation without checks, is enough.
- **preStop** gives the cluster a few seconds to stop routing to the pod before `SIGTERM` arrives,
  because endpoint updates are asynchronous.

## Deno Deploy and `deno serve`

Platforms that own the listener expect a module whose default export has a `fetch` handler:

```ts
// main.ts
const app = await createApp({ api, implementations, verifiers });
export default { fetch: app.fetch } satisfies Deno.ServeDefaultExport;
```

Run it locally with `deno serve --allow-net --allow-env main.ts`. Wrap `app.fetch` with plugins as
usual, for example `{ fetch: withCors(app.fetch, cors) }`.

The platform then decides when the process stops, and `serve`'s signal handling does not apply:
in-flight requests are drained only if the platform waits for them, and lifecycle resources are not
stopped explicitly. Prefer resources that tolerate an abrupt stop, such as connection pools that the
server side times out.

Turn on `no-legacy-abort` in `deno.json` (`"unstable": ["no-legacy-abort"]`). We have checked this
setting with `deno serve`, but not on Deno Deploy itself; check that `ctx.signal` stays unaborted
after responses before relying on it there.
