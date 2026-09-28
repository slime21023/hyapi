# ADR 0001: Layered error scopes and return-time request ownership

- Status: Accepted
- Date: 2026-09-24
- Scope: HyAPI application, request pipeline, resource scopes, and Deno listener

## Context

A request has several failure boundaries: startup and provider acquisition, routing and input,
handler execution, response hooks, resource cleanup, and network transmission. Treating all of these
as HTTP failures hides the original error, can run hooks twice, and cannot repair a response whose
status or body was already committed. Waiting for a discarded stream's `cancel()` or an
uncooperative resource closer can also block failure handling or application shutdown forever.

## Decision

Keep existing public `AppError` and problem+json codes; do not introduce a second wire error
hierarchy. The owning layer determines the recovery path:

| Boundary                           | Owner and outcome                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup/connect                    | `HyApiApp` rolls back acquired resources; the original failure remains first, with cleanup failures collected in `AggregateError`. No HTTP response exists.                                                                                                                                               |
| Request ingress and matched routes | `RequestPipeline.failure()` notifies group then global `onError` and serializes 4xx, deadline 503/504, contract 500, or hidden 500 before return. An unmatched 404 is a normal routing result: global `onResponse` sees it, `onError` does not.                                                           |
| Response hooks and final headers   | A throwing `onResponse` replaces the discarded response with a fresh problem response; remaining outer hooks run. Stream cancellation is best effort and never awaited. If a returned `Response` cannot be copied to add the request ID, notify once and return a new hidden 500 without rerunning hooks. |
| Request cleanup                    | Services close after response hooks and before `app.fetch()`/`app.request()` settles. Cleanup errors notify `onError` but do not overwrite the chosen HTTP response. Late service access fails with `SCOPE_CLOSED`.                                                                                       |
| Application cleanup                | `Scope` closes in LIFO order; one shared epoch-millisecond deadline bounds waits for asynchronous closers, records `TimeoutError` in a flat `AggregateError`, and continues invoking later closers. Synchronous work cannot be interrupted.                                                               |
| Returned body and network          | A native `Response` stream belongs to its producer/consumer after return. Stream or transport errors after status commitment cannot be converted to problem+json or reenter request hooks.                                                                                                                |

A native `Response` is opaque at the body-contract boundary: a declared status is checked, but its
body is neither cleaned nor validated against a response schema, even for `Response.json(...)`.
Framework-serialized helper results and bare values are cleaned and validated against any declared
response schema before return. Buffering a native body for schema enforcement would change the
stream ownership described above.

Request validation follows HTTP header case-insensitivity: a statically declared header property
keeps its schema spelling while matching the same header regardless of case. Case-colliding
properties in one object schema are ambiguous and fail configuration. For a statically inspectable
path-parameter object, a required property without a default that is absent from the registered
path's named parameters fails configuration rather than making every request fail validation.
Schema-less and dynamic schemas are not inferred or rejected.

OpenAPI documents both `application/json` for a declared failure-status body and
`application/problem+json` for the same 4xx/5xx status. A thrown `AppError` takes the problem path;
it is not validated against a handler's declared JSON body. Only existing declared or specifically
generated failure statuses gain that alternative; no speculative success or catch-all statuses are
introduced.

`onError` is a best-effort observer, not a recovery hook. Matched-route group observers run before
global observers, in order. Before each invocation, `lifecycle.error` is reset to the original
failure being reported, even if an earlier hook changed it; a hook's rejection cannot replace that
failure or change the selected HTTP response. Each observer is awaited only until it settles, the
request's original deadline expires, or forced shutdown aborts the request. Cleanup notifications
after the request scope ends use only the remaining original deadline. Unsettled observer promises
are abandoned from the response path and observed as background tasks: they may continue running and
mutate shared lifecycle state later, and completion is not guaranteed.

`onResponse` hooks run inner to outer while cooperative. An uncommitted hook still pending when the
request deadline or forced shutdown aborts cannot commit its earlier response: the pipeline discards
that body, selects the deadline 503/504 or shutdown 503 problem, and lets remaining outer hooks
inspect the replacement without recursively running hooks or notifying `onError` twice. The
abandoned hook promise is tracked and its later completion cannot restore the old status. If an
earlier error response was already selected before its `onError` observers reached the deadline,
later response hooks may inspect that selected error; they cannot wait indefinitely.

Request services close with the original request deadline even though the request timer has stopped
before cleanup. A timed-out async closer records `TimeoutError` and later closers still run; the
resulting cleanup error notifies `onError` without replacing the selected HTTP response. Forced
shutdown can release a request waiting on cleanup before that original deadline, preserving its
selected response while tracking the unfinished close for the bounded drain. An already-aborted
request gives asynchronous cleanup no further wait. Late closer failures are observed and reported
when possible, but uncooperative closer promises may continue after return.

On failed provider connection, rollback closer failures precede later plugin/module cleanup
failures. Nested `AggregateError` members are flattened recursively, preserving their order, so the
startup error list begins with the original connect exception. The application startup aggregate
retains the failed stage as its `cause`; for a failed provider connection, that provider aggregate
in turn retains the original connect exception as its `cause`. If application rollback adds no
errors, the provider aggregate is propagated without a second wrapper.

A body-schema route reads at most `bodyLimitBytes` from the original request once. The handler and
lifecycle hooks receive independent requests backed by those bounded bytes; hooks must clone their
shared lifecycle request before reading it. A 413, incomplete body, early validation error, or
schema-less streaming body has no guaranteed replayable snapshot. The request's deadline/shutdown
controller and client-disconnect controller combine into `ctx.signal`; forwarding of
`request.signal` stops when its scope ends. Only the deadline/shutdown controller determines the
503/504 timeout race.

For routes with a body schema, an unsupported media type is rejected with 415 before reading an open
body stream. The declared `Content-Length` limit is checked first, so an oversized declared body
still returns 413. Schema-less routes keep their streaming-body behavior.

`app.close()` stops admission, drains requests for up to `shutdownTimeoutMs`, aborts remaining
requests, waits up to `min(1000, shutdownTimeoutMs)` for cooperative cleanup, then gives the
application resource tree a separate `shutdownTimeoutMs` cleanup budget. Provider-connect and
startup rollback also use bounded cleanup. This budget does not cancel an external `setup()` or
`connect()` call that never resolves. Running uncooperative JavaScript may survive shutdown budgets
and use a provider after it closes; this is deliberately best effort, not a safety promise.

For Deno, `--unstable-no-legacy-abort` avoids a successful response appearing as a disconnect. The
example and generated listener start `app.close()` on shutdown, observe active transmissions with
`info.completed`, and call `server.shutdown()` when they finish. At `2 * shutdownTimeoutMs + 1000`
ms, they abort the ServeOptions signal **before** invoking `server.shutdown()`: Deno 2.9 can raise
`BadResource` when aborting a shutdown already waiting for an unfinished stream. `info.completed`
observes transport only; it never extends request scopes.

## Alternatives rejected

- Keep request services and providers alive until stream EOF: unbounded response lifetime would
  extend application shutdown and require a second stream ownership tracker. Streams instead own the
  resources they need after return.
- Wait indefinitely for handler or closer cooperation: a single stuck promise could prevent
  shutdown; bounded cleanup reports the failure and proceeds.
- Turn every 404, cleanup error, or post-commit stream failure into `onError` plus problem+json:
  these events have different ownership and cannot all be represented as a new HTTP response.

## Consequences

Callers must not access request services, providers, singletons, or `ctx.signal` from a returned
stream's `pull`/`cancel`; its independent resources must be closed by the stream itself. Callers
must clone a fully buffered lifecycle request before consuming its body. Operators must set a
termination grace above the listener deadline (61 seconds at defaults), plus process/external
overhead; forced shutdown cannot guarantee that uncooperative work has stopped. Existing public
error codes and `HyApplication.fetch(request)` remain unchanged.
