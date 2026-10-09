# Component: serve

- Package entry: `@hyapi/core/deno`
- Visibility: public

## Purpose

Host an application on a Deno HTTP listener with predictable startup and graceful shutdown. This is
the only Deno-specific component.

## Responsibilities

- Start `Deno.serve` with the application's `fetch` handler and listener options.
- Listen for configured signals, such as `SIGINT` and `SIGTERM`, and begin shutdown.
- Coordinate shutdown timing:
  - call the application's `close()`, which stops admitting requests, drains, and aborts;
  - wait for active transmissions; and
  - shut down the listener within a bounded budget.
- Return a handle with the listening address and a promise that settles when shutdown completes.

## Boundary

- No request processing, lifecycle hooks, or health logic. Those belong to [runtime](runtime.md).
- No TLS, CORS, compression, or other edge concerns.
- Never imported by the Web-standard entry `@hyapi/core`.

## Interface

`serve(app, options)` returns a server handle with the address and `finished`.

## Dependencies

The public `@hyapi/core` entry and Deno APIs only.

## Failure behavior

- A listener that fails to start rejects without leaving signal handlers installed.
- Shutdown that exceeds its budget is forced. Forced shutdown cannot guarantee that uncooperative
  user code has stopped.

## Related decisions

ADR 0001 §12; ADR 0002 §3, §4.

## Resolved in M5

- **Interface.**
  `serve(app, { port, hostname, signals, signal, shutdownTimeoutMs, onListen, fetch })` returns
  `{ addr, finished, shutdown() }`.
  - `signals` default to SIGINT and SIGTERM, or SIGINT and SIGBREAK on Windows, where SIGTERM cannot
    be observed.
  - An `AbortSignal` can also trigger the shutdown.
  - Signal handlers are installed only after the listener starts, and removed on shutdown.
- **Wrapped handlers (M7b).** `fetch` replaces `app.fetch` as the served handler, so outer wrappers
  such as CORS can be served while `serve` still closes `app` on shutdown.
- **Shutdown sequence.**
  - `app.close()` (draining, aborting, and stopping resources) and `server.shutdown()` (stopping
    accepting connections and waiting for open responses) run concurrently.
  - After `shutdownTimeoutMs` (default 30 s, kept above the app's budget), the listener's signal
    aborts open connections.
- **Failures (M8).** `finished` never rejects. `shutdown()` rejects with the application's close
  errors, and the application emits a `lifecycle.error` event for each failing resource, so a
  signal-triggered shutdown cannot leave an unhandled rejection.
  - `shutdown()` is idempotent and rethrows close failures.
- **Legacy abort on Deno 2.9.** Measured on Deno 2.9.7: without `--unstable-no-legacy-abort`, Deno
  still aborts `request.signal` after every successful response, and it prints a warning when
  listeners are attached. Handlers would see this as a client disconnect, so hosting with `serve()`
  requires the flag. The starter's tasks pass it.

## Open questions

- None.
