# Changelog

All notable changes to HyAPI are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-rc.2] - 2026-09-23

### Added

- `bodyLimitBytes` (default 10 MiB, 413 `PAYLOAD_TOO_LARGE`) and `requestTimeoutMs` (default 300000
  ms, 503 `REQUEST_TIMEOUT`) application settings, and `openapi.enabled`.
- `ctx.signal`, aborted when the request times out, and `ctx.requestIdHeader`.
- `HttpContractClientError` reasons `"deadline"` and `"aborted"`.
- 413 and 415 OpenAPI responses on routes with a request body; 401 on every protected route.
- MIT `LICENSE`, `SECURITY.md`, `docs/operations.md`, and `docs/baselines/performance.md`.
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
