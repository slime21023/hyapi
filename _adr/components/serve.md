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

## Open questions

- Whether rc.5's shutdown timing rules (the `--unstable-no-legacy-abort` requirement and the
  forced-abort ordering) still apply on the target Deno version.
