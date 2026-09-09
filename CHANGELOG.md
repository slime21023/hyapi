# Changelog

All notable changes to HyAPI are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.1.0] - 2026-08-28

### Added

- Initial HyAPI framework and example application.
