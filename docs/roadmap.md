# HyAPI Roadmap

HyAPI makes well-bounded modular monoliths easy to build while keeping service boundaries optional.
Business modules depend on explicit Ports, so a local provider can later be replaced by an HTTP
provider without changing use case code.

## Product principles

- Start with Application, Module, Route, and Schema; reveal advanced concepts only when needed.
- Use explicit, function-first composition without decorators or reflection metadata.
- Keep business Modules separate from cross-cutting platform Plugins.
- Fail early with actionable diagnostics for invalid graphs and contract mismatches.
- Keep distributed-system behavior explicit: remote calls declare contracts and timeouts.

## Release timeline

| Version     | Capability                                                                        | Status     |
| ----------- | --------------------------------------------------------------------------------- | ---------- |
| v0.1.1      | Quality baseline, contribution and release workflow                               | Completed  |
| v0.2.0      | Function-first Application/Module/Plugin composition and service scopes           | Completed  |
| v0.3.0      | Deno/JSR CLI, project/module generation, inspect/doctor, starter template         | Completed  |
| v0.4.0      | Typed Ports, local providers, contract tests, module boundary checks              | Completed  |
| v0.5.0      | HTTP contracts, typed clients, remote providers, propagation and extraction guide | Completed  |
| v0.5.1      | Runtime allocation and cleanup reliability optimizations                          | Completed  |
| v0.6.0      | Removal of the legacy composition bridge                                          | Completed  |
| v0.7.0      | Config defaults, `dependencies` naming, structured diagnostics and test helpers   | Completed  |
| v0.8.0      | Provider lifecycle and contract-version compatibility                             | Completed  |
| v0.9.0      | Distributed resilience and remote-call governance                                 | Completed  |
| v1.0.0-rc.1 | Production baseline hardening and release-candidate freeze                        | Superseded |
| v1.0.0-rc.2 | Audit remediation, Hono-free public API, release automation                       | Superseded |
| v1.0.0-rc.3 | Lifecycle correctness and next release-candidate gate                             | Candidate  |
| v1.0.0      | Production baseline and public API stability                                      | Future     |

## v0.8.0 — Provider lifecycle and contract compatibility

**Goal:** make local, fake, and HTTP providers behave consistently during startup, health checks,
contract validation, and shutdown.

- Add major/minor contract versions. A provider must have the same major and an equal-or-higher
  minor version.
- Add optional provider `connect`, `health`, and `close` lifecycle callbacks.
- Connect providers before the application becomes ready and aggregate all shutdown failures.
- Add `app.health()` returning healthy, degraded, or unhealthy provider status.
- Run the same contract suite against local, fake, and HTTP providers.
- Publish the provider lifecycle and version migration guide.

**Release gate:** incompatible versions fail before readiness; all provider close callbacks run;
health reports are deterministic; local/fake/HTTP implementations pass the same contract suite.

## v0.9.0 — Distributed resilience

**Goal:** make remote boundaries reliable without hiding distributed-system trade-offs.

- Enforce timeout budgets and parent request deadlines.
- Standardize retry/backoff and idempotency rules.
- Add circuit breaker and concurrency isolation primitives.
- Preserve consistent network, timeout, 4xx, 5xx, and contract error classification.

## v1.0.0 — Production baseline

**Goal:** stabilize the public API and provide an operationally predictable foundation.

- Publish API stability and compatibility policies.
- Establish runtime performance, security, and observability baselines.
- Document deployment and service extraction reference patterns.
- Automate release, package, and generated-project verification.

## v0.9 execution tasks (Implemented)

- [x] **RES-01:** Resilience error taxonomy and policy model.
- [x] **RES-02:** Request deadline and timeout budget support.
- [x] **RES-03:** Retry/backoff policy with safe-method defaults and jitter options.
- [x] **RES-04:** Circuit breaker primitive.
- [x] **RES-05:** Bulkhead/concurrency isolation primitive.
- [x] **RES-06:** HTTP provider integration.
- [x] **RES-07:** Reference documentation and migration guide.
- [x] **RES-08:** Reliability tests and release verification.

## v1.0.0-rc.1 — Candidate hardening

**Goal:** make the v0.9 API operationally predictable without adding a new public abstraction or
breaking existing application code.

- [x] **RC-01:** Clear resilience and HTTP timeout timers after completion; abort in-flight HTTP
      requests when their local timeout or propagated deadline expires.
- [x] **RC-02:** Make bulkhead admission FIFO and reserve released slots so queued work cannot be
      overtaken or exceed the configured concurrency.
- [x] **RC-03:** Count only transient/provider failures in circuit-breaker state; client and
      contract failures do not open the breaker.
- [x] **RC-04:** Enforce the smallest of local and `x-hyapi-deadline` budgets across HTTP retries,
      including propagated deadlines from `withHttpContext()`.
- [x] **RC-05:** Preserve the v0.9 public API and error names/reasons while tightening policy and
      deadline validation at trust boundaries.
- [x] **RC-06:** Keep the existing verification suite as the RC performance/resource baseline and
      cover the new queue, timeout, breaker, and deadline behavior with focused tests.
- [x] **RC-07:** Keep the RC dependency-free and reject malformed policy/deadline values before they
      reach runtime or remote calls.
- [x] **RC-08:** Require formatting, lint, type checking, the complete test suite, and synchronized
      package/CLI metadata before publishing the candidate.

The `v1.0.0-rc.1` freeze was lifted for the rc.2 audit remediation below. rc.2 is superseded by the
rc.3 lifecycle correctness candidate; its completed work and verification record remain below.

## v1.0.0-rc.2 — Audit remediation

**Goal:** fix the runtime, security, documentation, and CI gaps found in the rc.1 audit and deliver
the remaining v1.0 release artifacts. Pre-1.0 policy applies: superseded APIs are removed in the
same change, with migration notes only.

- [x] **RC2-01:** Versions, license, and publishability: `1.0.0-rc.2` metadata, MIT `LICENSE`,
      package `license`/`publish.exclude`, and a non-publishable example app.
- [x] **RC2-02:** Deadline trust boundary: one `x-hyapi-deadline` parser that accepts only 1-15
      digit values.
- [x] **RC2-03:** Resilience engine: abortable guards, timer-safe retry delays, a generation-based
      half-open circuit breaker, abortable bulkhead waiters, and a wider breaker exclusion list.
- [x] **RC2-04:** HTTP contract client: correct request methods, base URL path prefixes, a single
      retry loop, idempotency that `retryOn` cannot bypass, `deadline`/`aborted` reasons, and
      removal of the legacy `retry` option.
- [x] **RC2-05:** Provider lifecycle and versions: `ContractVersion`-only ports and contracts,
      parallel health checks with timeouts, and reverse-order provider shutdown.
- [x] **RC2-06:** Request pipeline: `bodyLimitBytes` (413), `requestTimeoutMs` (503), upstream
      deadlines (504), request-id validation, immutable-response handling, response field stripping,
      and route registration validation.
- [x] **RC2-07:** Hooks and groups: onion-ordered response hooks, error responses through group
      hooks, auth scope union without downgrade, and registration locked after start.
- [x] **RC2-08:** Services and ports: singletons cannot resolve request services, failed services
      are rebuilt, and `module.use` requires a `requires` declaration.
- [x] **RC2-09:** Application composition: `PlatformApi`-only plugins, startup rollback, and removal
      of Hono `raw` and the separate test-application factory.
- [x] **RC2-10:** JWT: byte-length secrets, malformed-token and `crit` rejection, strict `exp`/`nbf`
      checks, and clock-skew validation.
- [x] **RC2-11:** OpenAPI: 401 on every protected route, 413/415 on body routes, document caching,
      and `openapi.enabled`.
- [x] **RC2-12:** Test helpers tolerate empty response bodies.
- [x] **RC2-13:** CLI: nested file generation, name validation, shared-contract-aware inspection,
      and a doctor-clean starter template.
- [x] **RC2-14:** Example app restructured into `src/modules` with health, users, and orders
      modules.
- [x] **RC2-15:** CI and release automation: Windows matrix, publish dry-run, starter verification,
      tag-based publishing, and performance benchmarks.
- [x] **RC2-16:** v1.0 documentation: versioning policy, `SECURITY.md`, operations guide,
      performance baseline, and the rc.2 migration guide.

The `v1.0.0-rc.2` freeze was reopened for the rc.3 lifecycle correctness changes. See the candidate
milestone below; rc.2's work and verification record remain historical.

## v1.0.0-rc.3 — Lifecycle correctness candidate

**Goal:** ship the lifecycle and request-scope correctness changes recorded in the rc.3 changelog
with an explicit migration path and a release gate that cannot publish mismatched package versions.

- [x] Verify the generated starter's actual listener response and graceful shutdown, in addition to
      its `verify` task and CLI `doctor` report.
- [x] Require the publish workflow's tag to match both package versions.
- [x] Run `deno task verify` in the working checkout (200 tests, including generated listener and
      shutdown) and `deno publish --dry-run --allow-dirty` for a non-publishing preflight.
- [ ] Run `deno task verify`, `deno task publish:check`, and `git diff --check` in a clean checkout.
      Record results before tagging; do not publish until the clean gate passes.

## v1.0.0-rc.2 verification record

The release candidate is verified from the repository root with:

```text
deno task verify
deno task publish:check
```

`deno task verify` covers formatting, linting, type checking, the complete test suite, the example
`doctor` report, and a generated starter checked against local core source (the generated project's
`verify` task, including formatting, type checking, and tests, plus CLI `doctor`). It does not
establish that JSR dependencies resolve; after publishing, run
`deno run --allow-read --allow-write --allow-run --allow-env scripts/verify-starter.ts --published`
to check an unmodified starter. CI runs the gate on Ubuntu and Windows, and a release-checks job
runs a whole-tree whitespace check and the JSR publish dry-run. Performance results are recorded in
[docs/baselines/performance.md](baselines/performance.md).

## v1.0.0-rc.1 verification record

The release-candidate baseline is verified from the repository root with:

```text
deno task verify
git diff --check
```

The verification gate covers formatting, linting, type checking, and the complete test suite. The
workspace package metadata and generated CLI dependency are kept on the same `1.0.0-rc.1` line, and
unused validator dependencies are not part of the published core package. Delivered roadmap issues
are closed only after their implementation, documentation, and verification evidence are recorded in
the GitHub issue.

## Deferred and cancelled

- `hyapi generate route` is cancelled as a roadmap commitment; routes remain intentionally explicit
  through the Module/Route API.
- Event transports, outbox processing, Saga orchestration, service discovery, Kubernetes generation,
  and cloud-specific integrations remain optional after v1.0 and are not core commitments.

## v0.8 execution tasks (Implemented)

- [x] **SVC-01:** ContractVersion model and major/minor compatibility validator.
- [x] **SVC-02:** Provider lifecycle registry and startup/shutdown integration.
- [x] **SVC-03:** Application health report and provider diagnostics.
- [x] **SVC-04:** Local/fake/HTTP provider parity and lifecycle tests.
- [x] **SVC-05:** Reference example, migration guide, and API documentation.
- [x] **SVC-06:** Release gate, reliability checks, and package verification.

Every task must include a goal, key results, verification evidence, and migration notes where the
public API changes.
