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
  Header names match case-insensitively. JSON bodies are parsed within the size limit, and other
  declared media types are delivered raw. Bodies are never coerced.
- **Validation:** TypeBox validators are prepared at startup. HyAPI follows TypeBox's environment
  detection: compiled checking where evaluation is allowed, dynamic checking where it is forbidden.
  Violations are reported with location and JSON Pointer.
- **Responses:**
  - undeclared statuses are rejected;
  - undeclared fields are stripped, with a warning event in development;
  - responses are validated by policy (`off`, `log`, or `enforce`); and
  - raw `Response` results pass through after the status check.
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
handlers, verifiers, and event listeners need. The application object exposes `fetch`, `close`, and
`health`. Internal modules are not exported.

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
  - TypeBox's built-in formats are asserted, and so are formats registered with TypeBox
    `Format.Set`.
  - OpenAPI's `int32` is enforced as a range on a validation copy of the schema; the emitted schema
    is unchanged.
  - `int64`, `float`, `double`, `password`, `byte`, and `binary` are annotations.
  - Any other format fails startup (`unknown-format`).
- **Parameter defaults.** Absent query, header, and cookie parameters get their schema `default`
  (RFC 0001 amendment A2).
- **Bodies.** JSON (`application/json` and `+json`) is parsed and validated. `text/*` is decoded and
  validated. Other declared media types reach the handler as bytes, without validation.
- **Interim reporting.** Until read-only events arrive in M5, `log`-policy violations, development
  field stripping, and development startup warnings are written with `console.warn`.
- **Security.** Until M4, an operation with a security requirement fails startup
  (`security-not-supported`), so that it is never served unprotected.

## Open questions

- Per-operation timeouts: declared in the contract or configured in the application (M5).
- Whether verifiers within one AND requirement run concurrently or in order (M4).
- Whether events carry the `Request`, so that outer wrappers can correlate tracing spans (M5).
- Request bodies beyond JSON and text (`application/x-www-form-urlencoded` and
  `multipart/form-data`): a later goal.
