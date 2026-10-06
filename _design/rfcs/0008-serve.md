# RFC 0008: `serve()` for production listeners

- Status: Accepted (implemented in v1.0.0-rc.5)
- Target: v1.0.0-rc.5

## Problem

`Deno.serve(app.fetch)` is enough to run an application, but not to stop it correctly. A correct
shutdown starts `app.close()` immediately, keeps the listener open until in-flight transmissions
finish, enforces a grace deadline, and avoids a Deno 2.9 `BadResource` error raised when a listener
is aborted during `server.shutdown()`. The example application and the CLI starter each carried
about 75 lines of this coordination, which every application had to copy and keep correct.

## Decision

Core exports a listener helper that owns this coordination.

```ts
export interface ServeOptions {
  readonly hostname?: string; // default "127.0.0.1"
  readonly port?: number; // default 8000; 0 picks an ephemeral port
  readonly signal?: AbortSignal; // starts graceful shutdown when aborted
  readonly shutdownSignals?: readonly Deno.Signal[]; // none unless listed
  readonly onListen?: (addr: Deno.NetAddr) => void;
}

export interface HyServer {
  readonly addr: Deno.NetAddr;
  readonly finished: Promise<void>;
  shutdown(): Promise<void>;
}

export function serve(app: HyApplication, options?: ServeOptions): HyServer;
```

```ts
const server = serve(app, { port: 8000, shutdownSignals: ["SIGINT", "SIGTERM"] });
await server.finished;
```

### Semantics

- Shutdown starts `app.close()` at once, so new requests receive 503 and readiness fails while the
  application drains.
- The listener stays open until every in-flight transmission (`info.completed`) finishes, or until
  the grace deadline of `2 * shutdownTimeoutMs + 1000` ms. At the deadline it aborts the listener
  first and then calls `server.shutdown()`, which avoids the Deno 2.9 `BadResource` error.
- `shutdown()` is memoized. `finished` settles after both the listener and the application close,
  and rejects with their errors (an `AggregateError` when both fail).
- No signal handler is installed unless `shutdownSignals` lists it. On Windows only `SIGINT` and
  `SIGBREAK` exist; other listed signals are skipped there. Handlers are removed when shutdown
  starts.
- The default hostname is `127.0.0.1`, so a listener is never exposed by default.

`serve()` is lifecycle orchestration around the existing `app.fetch` and `app.close()`. It adds no
middleware, TLS, or proxy behavior; those stay at the edge.

## Compatibility and migration

Additive. Applications may keep their own `Deno.serve` code; replacing it with `serve()` is
recommended. The example application and the CLI starter now use `serve()`.

## Alternatives

- **Keep the code in examples and the starter:** every application inherits a subtle,
  runtime-specific workaround it must maintain.
- **Register `SIGINT` and `SIGTERM` by default:** this installs process-wide handlers as a hidden
  side effect.

## Acceptance criteria

- `serve()` binds, serves, and releases its port after `shutdown()` or an aborted `signal`.
- In-flight requests complete during shutdown.
- The generated starter's listener and shutdown verification passes using `serve()`.
