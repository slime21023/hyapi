# Changelog

All notable changes to HyAPI are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Narrow internal interfaces (Review 0002, roadmap M12a)

No public API or behavior changes; the public API snapshot is unchanged.

- Thirteen internal exports that no module imported, three more than Review 0002 listed, are private
  now, and a new architecture test requires every internal export to be imported or re-exported.
- `runtime/app.ts` keeps only state and process-wide effects (583 → 363 lines of code). Options and
  request IDs moved to `options.ts`, document endpoints to `documents.ts`, every startup check to
  `startup.ts` (formerly `binding.ts`), and startup diagnostics and `StartupError` to
  `diagnostics.ts`.
- `runtime/pipeline.ts` keeps the request half; the response half and the problem responses that
  HyAPI chooses moved to `respond.ts`.
- `isRecord` and `Dict` moved from `base/typebox.ts` to `base/record.ts`, and the CLI's
  `document.ts` is now `serialize.ts`.

### Internal structure (ADR 0004, roadmap M11)

No public API or behavior changes; the public API snapshot and the emitted documents are unchanged.

- `contract` is organized by reader: `declare/` for what applications write, `compile/` as the only
  interpreter, `model.ts` as the inner interface, and `infer.ts`. The 555-line operation normalizer
  is split into operation, parameters, body, and responses; security rules and named components each
  have one module.
- A Core-internal `base/` layer (L0) holds the HTTP and TypeBox mechanisms shared by `contract`,
  `runtime`, and `openapi`.
- New architecture tests: the runtime and the emitter import only the contract model, the compiler's
  entry point and diagnostics, and declaration types; dependencies inside `contract` point one way;
  and a public API snapshot (`deno task api:update`) makes every public change deliberate.
- The import graph of `packages/` is acyclic, and a test keeps it so. Two kinds of cycles, both
  through type-only imports, were removed: `OperationContext` moved from `compile/operation.ts` to
  `compile/context.ts`, and the CLI's `Io` moved from `run.ts` to `report.ts`.

## [0.2.5] - 2026-10-10

Observability and authorization (roadmap M10a), several documents (roadmap M10b), operations
(roadmap M10c), and fewer generics. The memory-leak fix found during M10c was released first, in
0.2.1. Some public types are removed or changed; see "Fewer generics" and "Changed".

### Operations

- `createApp({ bodyLimits })` sets request body limits per operation, keyed by `operationId`.
- A deployment guide: containers, Kubernetes probes and grace periods, Deno Deploy and `deno serve`.
- `"unstable": ["no-legacy-abort"]` in the root `deno.json` replaces the command-line flag; the
  starter project uses it.
- `deno task bench:http` measures throughput, latency, and memory over real HTTP.

### Fewer generics

- `AGENTS.md` prefers unions to generics, and requires named type parameters; an architecture test
  rejects one- and two-letter names.
- `Scheme<Identity, Credential>` is `Scheme<Identity>`; `httpBasic` returns a `BasicScheme`, and the
  credential type follows from the scheme.
- `Diagnostic` is no longer generic; `StartupError.diagnostics` is
  `(Diagnostic | StartupDiagnostic)[]`.
- `Implementation` is no longer generic.
- `HandlerFor`, `VerifierFor`, `SecurityOf`, `IdentityOf`, `CredentialOf`, `OperationIdsOf`,
  `PathParams`, and `OperationMap` are no longer exported; use `Handler`, `Verifier`, and
  `AppOptions`.
- `OperationOf` and `SecurityFor` are removed; use `typeof contract.operations.name` and
  `Parameters<Handler<typeof contract, "name">>[1]["security"]`.
- Every type parameter in the packages has a descriptive name, and public generic types document
  theirs.

### Several documents

- `createApp({ documents })` serves several emitted documents, each at its own path, with an
  optional `contentType`. It **replaces** the `document` option: write
  `documents: [{ path, content }]`.
- `hyapi.documents` in `deno.json` lists `{ name, api, openapi }`, where `openapi` may list several
  files. `emit`, `emit --check`, `doctor`, and `diff` work on every document. `--document <name>`
  selects one.
- `hyapi doctor` fails when an `operationId` names different routes in different documents.
- `hyapi diff --base <ref>` compares with any branch, tag, or commit.
- The example serves a public document (the catalog) and an internal one (with the operational
  endpoints), and turns on request IDs.

### Added

- `createApp({ requestId })`, off by default. When on, each request gets an ID. The ID appears on
  every event about the request, as `ctx.requestId` for handlers and verifiers, and in the
  `x-request-id` response header (configurable). With `trustIncoming`, a well-formed incoming ID is
  reused.
- `security.denied` events with the status, the reason (`missing`, `invalid`, or
  `insufficient-scope`), the accepted schemes, and the required scopes. They never include
  credentials.
- `request.unmatched` events for 404, 405, and malformed paths.
- `VerifierContext.requirements`: the operation's requirement in OpenAPI form.
- `ErrorInfo`: the `error` of `operation.end` and `lifecycle.error` includes `stack` and up to three
  levels of `cause`.
- 401 responses for API key schemes carry `WWW-Authenticate: ApiKey in="...", name="..."`.
- The authorization recipe: roles as scopes, resource rules as typed handler wrappers, and auditing.

### Changed

- `Context` and `VerifierContext` have a `requestId` field, and `VerifierContext` has
  `requirements`. Code that builds a `VerifierContext` itself, for example in tests, must add them.
- A verifier that throws `HttpError` is documented: it answers with that status and ends security
  evaluation.

## [0.2.1] - 2026-10-09

The first published release of the contract-first redesign: 0.2.0 with a memory leak fixed. 0.2.0
was prepared but not published, because of that leak.

### Fixed

- **Memory leak:** every request's signal stayed reachable from the application's shutdown signal
  until shutdown, about 1 KB per request, so long-running servers grew without bound. The pipeline
  combined the signals with `AbortSignal.any`, and Deno keeps such a signal reachable from its
  sources. Each request now has its own controller, which the application aborts at forced shutdown,
  and the server's heap stays flat under load. A regression test checks that requests leave no
  listeners behind and that the request path does not use `AbortSignal.any`.

## [0.2.0] - Not published

Prepared on 2026-10-09 but not published: it has the memory leak fixed in 0.2.1. Its changes are
first published in 0.2.1. It contains everything listed under 0.1.0, which was not published either,
together with the layered architecture (roadmap M8, [ADR 0003](_adr/0003-layered-architecture.md))
and correctness and safe defaults (roadmap M9, from
[Review 0001](_adr/reviews/0001-component-and-production-readiness.md)).

`1.0.0-rc.4` on JSR belongs to the superseded design and is unrelated to this release; see the note
before [1.0.0-rc.5](#100-rc5---superseded).

### Security

- Security fails closed: when the API declares security schemes, an operation without a requirement
  at any level is the startup error `implicit-public`. Mark public operations with `security: []`.
- Request bodies that are neither JSON nor text were passed to handlers unvalidated while typed as
  the declared schema. Their schema must now be `T.String({ format: "binary" })`
  (`unsupported-body-schema`), and handlers receive them typed as `Uint8Array`.
- `@hyapi/plugin-jwt` requires `audience`.
- `@hyapi/plugin-cors` adds `Vary: Origin` to every response unless the origin is `*`.
- The example rate-limits by the last `X-Forwarded-For` entry, which its proxy added, instead of the
  first, which clients control.

### Added

- `defineApi({ formats })` declares checks for custom `format` values. `createApp` registers them
  with TypeBox only after every startup check passes, and reports `format-conflict` when a name is
  already registered with a different check. New diagnostic `invalid-format`.
- `ContractError`, thrown by `emitOpenApi` with every diagnostic.
- `startup.warning` events with code `not-implemented` for `notImplemented` operations in
  development.
- Architecture tests for the layer edges of ADR 0003 and for module-level state, internal tests for
  the runtime mechanisms, and a test that pins the TypeBox behavior Core relies on.
- CI accepts intended breaking changes of the example API when a pull request has the `breaking-api`
  label.
- Response header values are validated against their schemas.
- Streamed response bodies count as in-flight requests: `close()` waits for them, cancels them when
  the shutdown budget runs out, and stops lifecycle resources afterwards.
- A result body may be a `ReadableStream`; streamed bodies are not validated.
- Diagnostic `reserved-schema-name` for schemas other than the built-in `Problem` named `Problem`.
- A test of the canonical wrapper order `withCors(withCsrf(withRateLimit(app.fetch)))`, and guide
  sections on the order, exposed headers, and proxy trust.

### Changed

- `checkContracts(api)` returns `{ ok, diagnostics }`; the contract model is internal.
- `emitOpenApi(api)` takes the API definition instead of a model.
- `StartupError.diagnostics` uses `Diagnostic` with `StartupDiagnosticCode`.
- The contract model is a deep, frozen copy of the declarations.
- Contract checking no longer reads TypeBox's process-wide format registry, so it gives the same
  result in `createApp`, `hyapi emit`, and `hyapi doctor`.
- `hyapi doctor` reads operations from the emitted document.
- The request body reader is cancelled when the request's signal aborts.
- `responseValidation: "off"` runs no response check and emits no `response.violation` event.
- `@hyapi/plugin-csrf` lets CORS preflight requests through without setting its cookie.
- Every module nests control blocks and closures at most two levels deep, a rule in `AGENTS.md` that
  an architecture test enforces. This changed no public API or behavior; the request-path benchmark
  is unchanged.

### Removed

- `ContractModel` and the other model types from `@hyapi/core/contract`.
- The `health` option of `createApp`, `draining` in `HealthReport`, and the module-level draining
  state. A closing application already answers 503 to every request.
- `ProblemCode` and `StartupDiagnostic`.

### Fixed

- `serve().finished` no longer rejects when a lifecycle resource fails to stop, which crashed the
  process with an unhandled rejection.

## [0.1.0] - Not published

The first version of the contract-first redesign. It was prepared but never published; its changes
were first published in 0.2.0.

### Added

- Engineering foundation (roadmap M0):
  - a workspace with the `@hyapi/core` skeleton and its four entry points;
  - TypeBox pinned to `~1.3.34`;
  - the public and internal test layout;
  - an architecture test that enforces the ADR 0002 dependency rules; and
  - a CI workflow that runs `deno task verify`.

- Contract component (roadmap M1), in `@hyapi/core/contract`:
  - `defineApi`, `defineContract`, `defineSchema`, `defineResponse`, `defineSecurity`, and the
    scheme constructors;
  - the `Problem` schema and input, result, and security inference types;
  - normalization into `ContractModel`; and
  - `checkContracts`, with 31 diagnostic rules.

  `@hyapi/core` adds `Handler`, `implement`, and `notImplemented`.

- Runtime request path (roadmap M2), in `@hyapi/core`:
  - `createApp` with startup diagnostics (`StartupError`);
  - exact routing with 404, 405 with `Allow`, and `HEAD`;
  - parameter decoding for the v1 style subset, with defaults and coercion;
  - bounded JSON and text bodies (413, 415, 400);
  - TypeBox validation, with `int32` ranges and unknown formats rejected;
  - response stripping and the `responseValidation` policy;
  - RFC 9457 problem responses with stable codes, `problem()`, and `HttpError`; and
  - request timeouts (503).
- Contract diagnostic `unknown-format`.
- Security (roadmap M4):
  - `createApp({ verifiers })`, typed per scheme, with credential extraction for every v1 scheme
    type;
  - ordered OR/AND evaluation with per-request caching;
  - scope checks, 401/403 classification with `WWW-Authenticate` challenges, and typed
    `ctx.security`; and
  - `@hyapi/plugin-jwt` with `jwtBearer` (HS256, RS256, ES256, and EdDSA, through jose).
- Lifecycle, hosting, and events (roadmap M5):
  - named `lifecycle` resources with ordered start, reverse stop, and rollback;
  - `app.close()`, which refuses new requests, drains, aborts the rest, and stops resources within a
    budget;
  - `createHealth`, which reports draining during shutdown, and the `HealthReport` schema;
  - read-only `onEvent` events;
  - per-operation `timeouts`;
  - the opt-in `document` endpoint; and
  - `serve()` in `@hyapi/core/deno`, with graceful, signal-driven shutdown.
- The starter uses `serve()`, and its tasks grant `--allow-env` and pass
  `--unstable-no-legacy-abort`.
- Evolution governance (roadmap M6):
  - `@hyapi/openapi-diff`, with `diffOpenApi` and `formatDiff`, which classify changes between two
    OpenAPI 3.1 documents with 32 direction-aware rules;
  - `hyapi diff`, which compares the current contracts with the document on `main` and fails on
    breaking changes unless `--allow-breaking` is given, with text, markdown, or JSON output; and
  - a starter `diff` task and a CI workflow.
- The remaining plugins (roadmap M7a):
  - `@hyapi/plugin-oidc` (`oidcBearer`), with discovery, JWKS rotation, and key-server failures
    reported as errors rather than invalid tokens;
  - `@hyapi/plugin-cors` (`withCors`), with explicit origins;
  - `@hyapi/plugin-csrf` (`withCsrf`), a signed double-submit check; and
  - `@hyapi/plugin-rate-limit` (`withRateLimit`), a fixed window per key, in memory.
- `problemResponse` is public in `@hyapi/core`.
- Documentation and the example (roadmap M7b):
  - the VitePress user guide (`deno task docs:dev`) and recipes for testing, typed clients, mocking,
    and observability; and
  - `apps/example`, a library API that uses every v1 feature.

  `serve()` gains a `fetch` option for wrapped handlers.
- Release readiness (roadmap M7c):
  - every package is at `0.1.0`, with explicit types for JSR;
  - `scripts/check_release.ts` and `tests/release/` check that versions and the changelog agree;
  - a tag-triggered publish workflow uses JSR OIDC, and CI runs `deno task publish:check`; and
  - `SECURITY.md` lists the concrete security defaults.
- An abort after the response is sent, such as a client disconnect, no longer leaves an unhandled
  promise rejection.
- OpenAPI emission and the contract CLI (roadmap M3):
  - `emitOpenApi` and `serializeOpenApi` in `@hyapi/core/openapi`, which emit deterministic,
    formatter-stable OpenAPI 3.1 with named components;
  - `@hyapi/cli` with `emit` (`--check`, JSON or YAML) and `doctor`; and
  - `new`, which creates a starter that passes its own verification.
- Request-path benchmarks (`deno task bench`).

### Changed

- HyAPI is redesigned as a contract-first API library: contracts are written in TypeScript with
  TypeBox, handler types are inferred from them, and they compile into a committed, governed OpenAPI
  3.1 document for external consumers. See [ADR 0001](_adr/0001-contract-first-api-library.md).
  `1.0.0-rc.5` is superseded and will not be published.

### Removed

- The superseded `1.0.0-rc.5` implementation: `@hyapi/core`, `@hyapi/cli`, the five plugin packages,
  the example application, tests, benchmarks, the starter verification script, the VitePress
  documentation site, and the CI and publish workflows. They remain in git history at commit
  `c52c0be`.
- The `_design/` records (RFCs 0001–0008, the earlier ADR 0001, migration notes, roadmap,
  performance baseline, and quality rule). They remain in git history at commit `c52c0be`;
  historical links below refer to that history.

> **The entries below belong to the superseded design.** It was replaced by the contract-first
> redesign above and shares no code with it. Its `1.0.0-rc.4` was published to JSR for
> `@hyapi/core`, `@hyapi/cli`, and four plugins; its `0.x` versions were never published there. The
> numbers `0.1.0` and `0.2.0` below therefore name different software than the releases above.

## [1.0.0-rc.5] - Superseded

### Added

- Guards ([RFC 0005](_design/rfcs/0005-guards.md)): `defineGuard`, `anyOf`, and `requireScopes`;
  `guards` on routes and groups run before body parsing and validation. OpenAPI security schemes and
  requirements are projected from guard metadata.
- `@hyapi/plugin-jwt`: `jwtBearer()`, an HS256 Bearer guard with the previous Core JWT rules.
- Module Port providers and module health
  ([RFC 0002](_design/rfcs/0002-provider-factories-and-module-health.md)): `module.provide()`,
  `module.healthCheck()`, `module.health()`, `module.liveness()`, and `app.liveness()`. Modules are
  ordered by the Ports they require and provide.
- Typed module configuration ([RFC 0003](_design/rfcs/0003-typed-module-configuration.md)):
  `Module.config` schemas, `createApplication({ moduleConfig })`, `module.config`, and
  `defineModule()`.
- Typed request state ([RFC 0004](_design/rfcs/0004-typed-request-state.md)): `defineStateKey()` and
  `RequestState`.
- `problemTypeBaseUrl` application setting for problem `type` URIs.
- Typed route responses ([RFC 0006](_design/rfcs/0006-typed-route-responses.md)): response helpers,
  bare results, and HTTP contract handlers are checked against declared `responses`; `defineRoute()`
  keeps inference for routes defined in their own files.
- Development diagnostics ([RFC 0007](_design/rfcs/0007-error-diagnostics-and-default-status.md)):
  with `environment: "development"`, problem responses include internal messages and details.
- `serve()` ([RFC 0008](_design/rfcs/0008-serve.md)): a listener helper that coordinates
  `app.close()` and graceful listener shutdown; the example and CLI starter use it.

### Changed

- **Breaking:** `AuthProvider`, `AuthRequirement`, `PlatformApi.setAuthProvider`, and the `auth`
  route/group option are removed in favor of guards. `jwtPlugin` and `JwtAuthProvider` moved out of
  Core; `@hyapi/plugin-oidc` exports `oidcBearer()` instead of `oidcPlugin()`.
- **Breaking:** `Identity` has a required `claims` field.
- **Breaking:** 401 responses carry `www-authenticate` only when the thrown `UnauthorizedError` sets
  a `challenge`; Core no longer hardcodes `Bearer`.
- **Breaking:** OpenAPI documents no longer include a default `bearerAuth` security scheme.
- **Breaking:** `Module.provides` lists Ports; implementations move into `module.provide()`.
- **Breaking:** `RequestContext.state` and `LifecycleContext.state` are `RequestState` instead of
  `Map<string, unknown>`.
- **Breaking:** problem `type` is `about:blank` unless `problemTypeBaseUrl` is configured.
- **Breaking:** handlers whose results disagree with their declared `responses` no longer compile.
- **Breaking:** `defineConfig()` defaults `environment` to `production`.
- **Breaking:** a `DELETE` handler that returns a body responds with 200 instead of failing the 204
  contract.
- `HealthCheckReport.detail` is typed as an omitted `string` rather than `string | undefined`.
- The example application provides its guard through an `authPort` Port, so its modules are plain
  values again.
- CLI `doctor` recognizes `provides: [...]` declarations as module Port providers.

## [1.0.0-rc.4] - Superseded

### Added

- English VitePress usage documentation and a focused `deno task test:public` release-contract
  suite.
- `@hyapi/plugin-cors` and `@hyapi/plugin-rate-limit`: optional native HTTP wrappers for explicit
  CORS rules and bounded in-process fixed-window rate limiting.
- `@hyapi/plugin-oidc`: optional OIDC Bearer authentication through explicit issuer, audience,
  algorithms, and remote JWKS settings.
- `@hyapi/plugin-csrf`: optional signed double-submit CSRF wrapper for cookie-authenticated browser
  traffic with exact Origin rules.
- `shutdownTimeoutMs` application setting (default 30000 ms): `app.close()` drains in-flight
  requests for up to this long, aborts remaining `ctx.signal`s, then uses a separate cleanup budget
  of the same length for application resources.
- [ADR 0001](_design/decisions/0001-layered-error-scopes.md) records the error owners,
  request/stream lifetimes, bounded cleanup, and Deno listener tradeoffs.

### Changed

- The core runs on one lifecycle state machine: application and request resources are released in
  reverse order by a shared scope, and every error response comes from one request pipeline.
- **Breaking:** requests received before start or after `close()` return 503
  `APPLICATION_UNAVAILABLE`, and `app.health()` reports `unhealthy` once the application stops.
- **Breaking:** `requestTimeoutMs` also bounds global `onRequest` hooks; `ctx.signal` also aborts
  when the client disconnects.
- **Breaking:** when an `onResponse` hook throws, the remaining outer hooks still run and see the
  error response.
- **Breaking:** resolving a request-scoped service after its request, or a singleton after
  `close()`, rejects with `SCOPE_CLOSED`; request cleanup failures only reach `onError`.
- Application cleanup and startup rollback use bounded asynchronous closer deadlines; shutdown gives
  cooperative aborted requests a short final drain before closing providers. Native `Response`
  streams remain caller-owned after the request returns.
- Publishing rejects a release tag unless it matches both package versions; generated starter
  verification checks the listener's HTTP response and graceful shutdown, not only its project
  checks and `doctor` report.

### Fixed

- `close()` drains cooperative requests before closing providers and singletons; timed-out
  uncooperative work may still run after resource closure. Requests after `close()` never reuse
  closed singletons.
- Request services created after a request timed out are closed instead of leaked.
- HTTP client retry backoff stops as soon as the caller aborts.
- Typed HTTP contract clients allow callers to omit `body` when a route declares
  `bodyRequired: false`; required-body routes still require it.
- CLI `doctor` reports missing providers even when unrelated modules reuse a Port variable name;
  same-named references now resolve within their own module.
- `bodyLimitBytes` also applies to routes without a body schema that read `ctx.request`; an
  oversized streamed body returns 413 instead of hanging, and a request timeout cancels a stalled
  body read.
- Unsupported media types on typed-body routes now best-effort cancel the request source without
  delaying 415; oversized bodies still take precedence with 413.
- Resilience timeouts count as circuit-breaker failures and release their half-open probe and
  bulkhead slot even if the abandoned operation never settles.
- Error responses that replace a handler response (for example after a failing global `onResponse`
  hook) no longer inherit its headers such as `Set-Cookie` or `Location`.
- `createApplication` fills defaults for partial configs that set `requestIdHeader` and
  `openapi.path`.
- Unmatched 404s bypass `onError` while retaining global `onResponse`; relative request strings
  retain the localhost origin, including `//` paths and colon-containing segments.
- Discarded response stream cancellation cannot block error serialization; nonconstructible
  responses produce a fresh hidden 500 while immutable redirects retain their status and headers.
- Body-schema routes can replay bounded content independently to handler and lifecycle hooks, and
  client aborts no longer change `ctx.signal` after request-scope cleanup.
- Asynchronous `onError` observers no longer hold failed requests or cleanup notifications past the
  request deadline or forced shutdown. Group then global hooks each see the original failure even if
  a preceding hook changed `lifecycle.error`; abandoned observers may continue later.
- Startup failures flatten nested provider rollback and plugin/module cleanup errors in order, with
  the original connect exception first and the cause chain preserved.
- Example and generated Deno listeners avoid legacy successful-response aborts and defer
  `server.shutdown()` until transmission finishes or the forced-stop deadline expires.

## [1.0.0-rc.2] - 2026-09-23

### Added

- `bodyLimitBytes` (default 10 MiB, 413 `PAYLOAD_TOO_LARGE`) and `requestTimeoutMs` (default 300000
  ms, 503 `REQUEST_TIMEOUT`) application settings, and `openapi.enabled`.
- `ctx.signal`, aborted when the request times out, and `ctx.requestIdHeader`.
- `HttpContractClientError` reasons `"deadline"` and `"aborted"`.
- 413 and 415 OpenAPI responses on routes with a request body; 401 on every protected route.
- MIT `LICENSE`, `SECURITY.md`, `docs/guide/operations.md`, and `_design/baselines/performance.md`.
- Core benchmarks (`deno task bench`), example `doctor` and generated-starter verification in
  `deno task verify`, a Windows CI matrix, a JSR publish dry-run, and tag-based publishing.
- CLI `inspect` reads shared ports from `src/contracts/` and `src/app.ts` and lists requirements and
  providers; `generate module` prints registration instructions.

### Changed

- **Breaking:** auth scopes from groups and routes are merged as a union; inherited authentication
  cannot be disabled or made optional.
- **Breaking:** group and global `onResponse` hooks run in onion order, and error responses pass
  through group hooks.
- **Breaking:** hooks, routes, and auth providers cannot be registered after startup.
- **Breaking:** plugins receive a `PlatformApi` with only `addHook` and `setAuthProvider`.
- **Breaking:** `module.use(port)` requires the port in `requires`; singleton factories cannot
  resolve request-scoped services.
- **Breaking:** `ctx.deadline` is always set; an expired upstream `x-hyapi-deadline` returns 504
  `DEADLINE_EXCEEDED` before the handler runs.
- **Breaking:** response bodies are cleaned of fields not declared in the response schema.
- **Breaking:** JWT secrets are measured in bytes; `crit` headers, missing `exp`, and non-numeric
  `nbf` are rejected.
- Deadline headers accept only 1-15 digit values; incoming request IDs must match
  `^[A-Za-z0-9._:-]{1,128}$`.
- Circuit breakers use a generation-based half-open state; bulkhead waiters and resilience guards
  are abortable.
- `app.health()` checks providers in parallel with a 5-second timeout; providers close in reverse
  order; startup failures roll back set-up modules and plugins.
- The example app uses the `src/modules` layout and is no longer a publishable package.

### Removed

- **Breaking:** Hono `raw` on request and lifecycle contexts.
- **Breaking:** `createTestApplication`; use `createApplication({ overrides })`.
- **Breaking:** HTTP client `retry` option and `HttpRetryOptions`; use `resilience.retry`.
- **Breaking:** numeric port/contract versions, `PortVersion`, and `normalizeContractVersion`.

### Fixed

- HTTP contract clients send the contract's HTTP method instead of always `GET`, and preserve
  `baseUrl` path prefixes.
- Non-idempotent requests are never retried, even with a custom `retryOn`.
- Deadline-bound, aborted, and client/contract failures no longer open circuit breakers.
- Malformed JWTs return 401 instead of 500.
- `Response.redirect()` and forwarded fetch responses no longer fail with 500.
- A request-service cleanup failure no longer replaces a successful response.
- A handler that throws `SyntaxError` returns 500 instead of 400.
- Failed singleton and request services are rebuilt on the next resolution.
- CLI module generation creates nested directories and rejects names that do not start with a
  letter.

## [1.0.0-rc.1] - 2026-09-09

### Changed

- HTTP clients honor propagated absolute deadlines across fetches and retries, and clean up timeout
  resources after completion.
- Bulkhead admission is FIFO with reserved concurrency slots.
- HTTP resilience guards retain circuit-breaker and bulkhead state across calls to a client.
- Circuit breakers ignore client and contract failures when calculating their threshold.
- Resilience policy and deadline inputs fail early when invalid.

### Compatibility

- No public API names, signatures, or error reason values changed from v0.9.0.

## [0.2.0 – 0.9.0] - undated

### Added

- Repository roadmap, contribution workflow, and development issue template.
- Function-first application composition with Modules, Plugins, and scoped services.
- A v0.2 migration guide.
- `@hyapi/cli` project/module generation, inspection, and boundary diagnostics.
- Typed Ports, provider registration, and reusable provider contract-test helpers.
- Users + Orders reference composition using a local User Directory port.
- Shared HTTP contracts, typed clients, remote Port providers, and a service-extraction guide.
- `defineConfig()` defaults, structured boundary diagnostics, JSON CLI output, and framework-neutral
  request/provider test helpers.
- Provider connect/health/close lifecycle, health reports, and major/minor contract compatibility.
- Explicit resilience policies for retry/backoff, timeout budgets, circuit breakers, and bulkheads.

### Changed

- Text-file checkout rules are standardized on LF for deterministic Deno formatting.
- Release documentation now records the v1.0.0-rc.1 verification baseline and issue evidence
  requirements.
- The core package no longer declares the unused AJV validator dependency.
- **Breaking:** `createApp`, registration plugins, decorations, and root route registration are
  replaced by `createApplication`, Modules, Plugins, and service references.
- **Breaking (v0.7):** module startup `imports` is renamed to `dependencies`; `doctor()` now returns
  structured diagnostics.
- **v0.8:** provider versions accept major/minor compatibility and `HyApplication` exposes health;
  HTTP providers may configure `healthPath`.

## [0.1.0] - 2026-08-28

### Added

- Initial HyAPI framework and example application.
