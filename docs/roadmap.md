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

| Version     | Capability                                                                        | Status      |
| ----------- | --------------------------------------------------------------------------------- | ----------- |
| v0.1.1      | Quality baseline, contribution and release workflow                               | Completed   |
| v0.2.0      | Function-first Application/Module/Plugin composition and service scopes           | Completed   |
| v0.3.0      | Deno/JSR CLI, project/module generation, inspect/doctor, starter template         | Completed   |
| v0.4.0      | Typed Ports, local providers, contract tests, module boundary checks              | Completed   |
| v0.5.0      | HTTP contracts, typed clients, remote providers, propagation and extraction guide | Completed   |
| v0.5.1      | Runtime allocation and cleanup reliability optimizations                          | Completed   |
| v0.6.0      | Removal of the legacy composition bridge                                          | Completed   |
| v0.7.0      | Config defaults, `dependencies` naming, structured diagnostics and test helpers   | Completed   |
| v0.8.0      | Provider lifecycle and contract-version compatibility                             | Implemented |
| v0.9.0      | Distributed resilience and remote-call governance                                 | Implemented |
| v1.0.0-rc.1 | Production baseline hardening and release-candidate freeze                        | Candidate   |
| v1.0.0      | Production baseline and public API stability                                      | Future      |

## v0.8.0 — Provider lifecycle and contract compatibility

**Goal:** make local, fake, and HTTP providers behave consistently during startup, health checks,
contract validation, and shutdown.

- Add major/minor contract versions. A provider must have the same major and an equal-or-higher
  minor version; legacy numeric versions map to `{ major: n, minor: 0 }`.
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

After `v1.0.0-rc.1`, runtime and public API changes are frozen. Follow-up work is limited to test
coverage, repeatable performance measurements, security regression checks, and documentation or
example corrections.

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
