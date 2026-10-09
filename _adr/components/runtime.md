# Component: runtime

- Package entry: `@hyapi/core`
- Visibility: public assembly API only. Everything else in the runtime is internal.

## Purpose

Turn a `ContractModel` and its implementations into a running application that exposes a
Web-standard `fetch` handler, and hold the runtime behavior to the contract.

## Responsibilities

### Assembly and lifecycle

- `implement(contract, handlers)` binds one handler per `operationId`. Its type requires an entry
  for every operation. `notImplemented` marks an operation that has no handler yet.
- `createApp(options)`:
  - runs `checkContracts` and stops on errors;
  - runs implementation-bound diagnostics: missing or extra handlers, schemes without verifiers, and
    verifiers without schemes;
  - lists `notImplemented` operations;
  - prepares routes, decoders, validators, and security plans from the `ContractModel`; and
  - reports every diagnostic together and refuses to start on errors.
- The application exposes `fetch(request)`, `close()`, and `health()`.
- Runs startup and shutdown hooks. `close()` stops admitting requests, drains within a budget,
  aborts the remaining requests, and then runs shutdown hooks.
- Aggregates application-provided health checks. A health endpoint is an ordinary declared operation
  whose handler calls the aggregator.
- Serves an emitted OpenAPI document at an explicit, opt-in path. The application passes in the
  document.

### Request execution

The flow runs in a fixed order:

```text
route match (404, or 405 with Allow; HEAD served for GET)
  → security (401 / 403)
  → parameter decoding and validation (400)
  → body media type, size, parsing, and validation (415 / 413 / 400)
  → handler (signal, timeout; 501 for notImplemented)
  → response checks: declared status, field stripping, validation policy
  → encoding → Response
```

- **Security:** credentials are extracted per scheme, verifiers are called with the request signal,
  requirements are evaluated (alternatives are OR, schemes within one requirement are AND), and
  declared scopes are checked.
- **Decoding:** supported parameter styles are deserialized and coerced to their schema types.
  Header names match case-insensitively. JSON bodies are parsed within the size limit, `text/*`
  bodies are decoded, and other media types are delivered as bytes. Bodies are never coerced.
- **Validation:** TypeBox validators are prepared at startup. HyAPI follows TypeBox's environment
  detection: compiled checking where evaluation is allowed, dynamic checking where it is forbidden.
  Violations are reported with location and JSON Pointer.
- **Responses:**
  - undeclared fields are stripped, with a warning event in development;
  - the declared status, body schema, and header schemas are checked by policy: `enforce` answers
    500, `log` sends the response and emits `response.violation`, and `off` runs no check;
  - raw `Response` results pass through after the status check; and
  - streamed bodies are not validated, and stay in flight until they end.
- **Cancellation:** each request has one `AbortSignal` that combines client disconnect, the request
  timeout, and shutdown. A timeout produces a 503 or 504 response.
- **Errors:** every framework failure becomes an RFC 9457 problem+json response with a stable `type`
  and `code`. Internal detail is hidden outside development mode. `HttpError` is the public error
  for cross-cutting failures.
- **Events:** read-only events cover operation start and end, response stripping and validation
  reports, and calls to deprecated operations. Listener failures are isolated.

## Boundary

- Never reads raw contract declarations or re-derives normalization decisions. Its only contract
  input is the `ContractModel`.
- No OpenAPI generation. Serving a document means returning the document the application supplied.
- No network listener or OS signal handling. Those belong to [serve](serve.md).
- No service container, plugin interface, middleware, or mutable hooks. Dependencies reach handlers
  through closures. Event listeners cannot change requests or responses.
- No verification algorithms such as JWT or OIDC. Those are verifier [plugins](plugins.md).
- No business authorization beyond declared scopes.

## Interface

`createApp`, `implement`, `notImplemented`, `HttpError`, application options, and the types that
handlers, verifiers, and event listeners need. The application object exposes `fetch` and `close`.
Internal modules are not exported.

## Modules

The runtime spans layers L2–L4 of [ADR 0003](../0003-layered-architecture.md); its §3 table assigns
every module, and the architecture test enforces the edges and the absence of module-level state.

- **L2 mechanisms:** `deadline`, `routing`, `params`, `body`, `validation`, `security`, `problem`,
  `health`, `lifecycle`, and `handler`. They return results and emit nothing.
- **L3 request flow:** `pipeline` returns an `Outcome` with the response and its facts: problem
  `code`, thrown error, security denial, response violations, and stripped fields.
- **L4 application:** `binding` (startup checks of implementations, handlers, timeouts, verifiers,
  and lifecycle resources), `events`, and `app`, the only owner of state and emitter of events.

## Dependencies

[contract](contract.md) and TypeBox. Never imports [openapi](openapi.md) or [serve](serve.md).

## Failure behavior

- Startup failures are collected into one error that lists every diagnostic. No partially started
  application is returned. A failing startup hook rolls back earlier hooks in reverse order.
- Every failure before a response is committed becomes a problem response. Building a problem
  response never throws; a fixed minimal 500 is the last resort.
- After a raw `Response` is returned, stream and transport failures cannot become problem responses.
- A handler that ignores its signal may keep running after its timeout response. This is documented
  as best effort.
- Shutdown is bounded. Cleanup failures are aggregated, and later hooks still run.

## Related decisions

ADR 0001 §4–§8, §11–§14; ADR 0002 §1–§5; RFC 0001 §6–§8 (handler, verifier, and `createApp` API).

## Resolved in M2

- **Options and defaults.**
  - `createApp({ api, implementations, development = false, responseValidation, requestTimeoutMs = 30000, bodyLimitBytes = 1048576 })`.
  - `responseValidation` defaults to `enforce` in development and `log` otherwise.
  - Startup failures throw `StartupError` with every diagnostic.
- **Routing.** Paths match exactly: there is no trailing-slash folding and no catch-all parameters
  in v1. The more literal template wins, and methods are looked up across every matching template.
- **Problem `type`.** The `type` is `about:blank`, `title` is the reason phrase, and a stable `code`
  extension member identifies the problem. Validation failures add `violations` with `location`,
  `pointer`, and `message`. At most 20 violations are reported per value.
- **Formats.**
  - TypeBox's built-in formats are asserted, and so are formats declared with
    `defineApi({ formats })` (since M8; before, formats registered with TypeBox `Format.Set`).
  - OpenAPI's `int32` is enforced as a range on a validation copy of the schema; the emitted schema
    is unchanged.
  - `int64`, `float`, `double`, `password`, `byte`, and `binary` are annotations.
  - Any other format fails startup (`unknown-format`).
- **Parameter defaults.** Absent query, header, and cookie parameters get their schema `default`
  (RFC 0001 amendment A2).
- **Bodies.** JSON (`application/json` and `+json`) is parsed and validated. `text/*` is decoded and
  validated. Other declared media types reach the handler as bytes, without validation (since M9,
  their schema must be a binary string; see below).
- **Reporting.** Superseded in M5 by read-only events (see below).

## Resolved in M4

- **Verifiers.** `createApp({ verifiers })` takes one function per security scheme. Types require it
  whenever the API declares schemes, and startup reports `missing-verifier`, `unknown-verifier`, and
  `invalid-verifier`. A verifier receives the scheme's credential and
  `{ signal, request, operationId }`. It returns `{ identity, scopes? }`, or `null` for an invalid
  credential. A thrown error is an internal failure (500).
- **Credentials.** `http` bearer, `oauth2`, and `openIdConnect` schemes read
  `Authorization: Bearer <token>`. `http` basic schemes decode `Authorization: Basic` to
  `{ username, password }`; a malformed value counts as an invalid credential. `apiKey` schemes read
  their declared header, query parameter, or cookie. A missing credential never calls the verifier.
- **Evaluation.** Alternatives are tried in order, and the first satisfied one wins. Schemes within
  a requirement are verified in declaration order, stopping at the first failure. Each scheme is
  verified at most once per request. Security runs before parameter and body validation, and
  verifiers are bounded by the request timeout.
- **Failures.** A credential that verifies but lacks a required scope produces 403 `FORBIDDEN`, with
  `WWW-Authenticate: Bearer error="insufficient_scope"` for bearer schemes. Any other failure
  produces 401 `UNAUTHORIZED`, with `Bearer` and `Basic realm="<API title>"` challenges for the
  HTTP-based schemes involved.

## Resolved in M5

- **Lifecycle.** `createApp({ lifecycle: [{ name, start?, stop? }] })` starts resources in order
  before returning the application. If one fails, the started ones are stopped in reverse order and
  the original error is thrown; rollback failures are added in an `AggregateError`.
- **Close.** `app.close()` is idempotent and runs these steps:
  1. new requests get 503 `SHUTTING_DOWN`;
  2. in-flight requests drain within `shutdownTimeoutMs` (default 10 s);
  3. the remaining requests are aborted through their signal, and answer 503 `SHUTTING_DOWN`; and
  4. lifecycle resources stop in reverse order, sharing one budget.

  Stop failures and timeouts are aggregated, and the later resources still stop.
- **Health.** `createHealth(checks, { timeoutMs })` is a standalone aggregator, so handlers use it
  without a cycle. Checks run concurrently with a timeout. The overall status is the worst check
  status. The `HealthReport` schema lives in `@hyapi/core/contract` for health operation contracts.
  (Since M8, health has no draining state: a closing application answers 503 to every request.)
- **Events.** `createApp({ onEvent })` receives read-only events:
  - `operation.start` and `operation.end` (status, duration, problem `code`, thrown error, and the
    `deprecated` flag);
  - `response.violation` and `response.stripped` (development only);
  - `startup.warning`; and
  - `lifecycle.error`.

  Events do not carry the `Request`. Listener errors are contained. Without a listener, problem
  events fall back to `console.warn`, so the `log` policy is never silent. Unmatched requests (404
  and 405) emit no operation events.
- **Per-operation timeouts.** `createApp({ timeouts: { operationId: ms } })` overrides
  `requestTimeoutMs`. The keys are typed by the API's `operationId`s, and unknown keys fail startup.
  Timeouts are operational settings and stay out of the contract and the emitted document.
- **Document endpoint.** `createApp({ document: { path, content } })` serves an emitted document on
  GET and HEAD. A path that collides with a declared route fails startup
  (`document-route-conflict`).
- **Conditional statuses.** Return one object per status, for example
  `ok ? { status: 200, body } : { status: 503, body }`. TypeScript cannot split
  `{ status: 200 | 503 }` across a union that also allows a raw `Response` (RFC 0001 A12).

## Resolved in M8

- **Layers.** The modules above, per ADR 0003. `wire.ts` was split into `params.ts` and `body.ts`;
  the body reader is cancelled when the request's signal aborts.
- **Formats.** `createApp` checks that each declared format is not registered in the process with a
  different check (`format-conflict`). It registers them only after every startup check passes, and
  before it compiles validators: TypeBox resolves formats at compile time, so a format registered
  later would never be checked.
- **Startup.** `StartupError.diagnostics` is `Diagnostic<DiagnosticCode | StartupDiagnosticCode>[]`.
  In development, each `notImplemented` operation emits `startup.warning` with code
  `not-implemented`.
- **Events.** The application derives every event from pipeline outcomes and lifecycle failures; it
  no longer parses its own problem responses to find their `code`.

## Resolved in M9

- **Byte bodies.** Request bodies that are neither JSON nor text reach the handler as a
  `Uint8Array`, which `InputOf` reflects; their schema must be `T.String({ format: "binary" })` (RFC
  0001 A24).
- **Response policy.** Header values are validated against their schemas. Every response check,
  including the declared status, follows `responseValidation`; `off` reports nothing (A26).
- **Streaming.** The pipeline marks raw `Response` bodies and stream bodies as streaming. The
  application wraps them, keeps the request in flight until the body ends, fails, or is cancelled,
  and cancels the body when the shutdown budget runs out. `close()` therefore stops lifecycle
  resources only after every stream has ended. A raw `Response` replaced by a 500 under `enforce`,
  and the body of a HEAD response, are cancelled.

## Resolved in M10a

- **Request IDs (RFC 0001 A27).** `createApp({ requestId })` is off by default. The application
  layer assigns the ID before routing: a trusted, well-formed incoming value, or a random UUID. It
  passes the ID to the pipeline as part of `Incoming`, adds it to events, and sets the response
  header on every answer, including 404s and refusals during shutdown.
- **Denials (A28).** The security evaluator's `Denial` carries the accepted schemes and the required
  scopes; the application reports it as `security.denied`.
- **Verifier context (A29).** The plan holds the operation's requirement in OpenAPI form once, and
  every verifier call receives it as `requirements`.
- **Errors (A30).** `describeError` returns an `ErrorInfo` with `stack` and up to three levels of
  `cause`; events carry it whole.
- **API key challenge (A31).** `ApiKey in="...", name="..."` joins the 401 challenges.
- **Unmatched requests (A32).** The application emits `request.unmatched` for 404, 405, and
  malformed paths, but not for the document endpoint or for refusals during shutdown.

## Open questions

- Request bodies beyond JSON and text (`application/x-www-form-urlencoded` and
  `multipart/form-data`): a later goal.
