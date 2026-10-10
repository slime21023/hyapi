# HyAPI roadmap

- Status: living document. Update a milestone's status when its exit criteria are met.
- Date: 2026-10-08
- Basis: [ADR 0001](0001-contract-first-api-library.md),
  [ADR 0002](0002-architecture-and-component-boundaries.md),
  [RFC 0001](rfcs/0001-contract-and-handler-api.md), and the
  [component specifications](components/README.md); M8–M10 are based on
  [Review 0001](reviews/0001-component-and-production-readiness.md) and
  [ADR 0003](0003-layered-architecture.md); M11 is based on
  [ADR 0004](0004-contract-structure-and-base.md); M12 is based on
  [Review 0002](reviews/0002-interfaces-and-module-depth.md)

## v1 goal

HyAPI v1 is the first published release. It must be usable in production for HTTP JSON APIs:
contracts are written in TypeScript, handlers are type-checked against them, the runtime holds
requests and responses to them, and the committed OpenAPI document is emitted and governed.

### In scope for v1

- Packages: `@hyapi/core` (all four entry points), `@hyapi/cli`, `@hyapi/openapi-diff`, and the five
  plugins (`jwt`, `oidc`, `cors`, `csrf`, `rate-limit`).
- The behavior of ADR 0001 §1–§16 and the API of RFC 0001.
- User documentation, an example application, a starter template, CI, and release automation.

### Later goals (not in v1)

Mock mode, a typed client package, `hyapi import`, an optional API explorer, form and multipart
request bodies, and parameter styles beyond the v1 subset.

## Milestones

| Milestone                                      | Goal                                                 | Components                             | Depends on | Status            |
| ---------------------------------------------- | ---------------------------------------------------- | -------------------------------------- | ---------- | ----------------- |
| [M0](#m0-engineering-foundation)               | Engineering foundation                               | repository                             | —          | Done (2026-10-08) |
| [M1](#m1-contract)                             | Contracts, inference, normalization, diagnostics     | contract                               | M0         | Done (2026-10-08) |
| [M2](#m2-runtime-request-path)                 | Runtime request path without security                | runtime                                | M1         | Done (2026-10-08) |
| [M3](#m3-openapi-emission-and-cli)             | OpenAPI emission and the contract CLI                | openapi, cli                           | M1         | Done (2026-10-08) |
| [M4](#m4-security)                             | Security evaluation and the JWT verifier             | runtime, plugins                       | M2         | Done (2026-10-08) |
| [M5](#m5-lifecycle-hosting-and-events)         | Lifecycle, hosting, health, and events               | runtime, serve                         | M2         | Done (2026-10-08) |
| [M6](#m6-evolution-governance)                 | Evolution governance                                 | openapi-diff, cli                      | M3         | Done (2026-10-08) |
| [M7](#m7-v1-release)                           | Remaining plugins, documentation, and the v1 release | plugins, all                           | M4, M5, M6 | Done (2026-10-09) |
| [M8](#m8-layered-architecture)                 | Layered architecture (ADR 0003)                      | contract, runtime, openapi, serve, cli | M7         | Done (2026-10-09) |
| [M9](#m9-correctness-and-safe-defaults)        | Correctness and safe defaults (0.2.0)                | runtime, contract, plugins             | M8         | Done (2026-10-09) |
| [M10](#m10-production-features)                | Production features (0.2.5)                          | runtime, serve, cli, plugins           | M9         | Done (2026-10-09) |
| [M11](#m11-contract-structure-and-base)        | Contract structure and the base layer (0.3.0)        | contract, runtime, openapi             | M10        | Done (2026-10-10) |
| [M12](#m12-narrow-interfaces-and-deep-modules) | Narrow interfaces and deep modules (0.3.0)           | all packages                           | M11        | Planned           |

```text
M0 ─► M1 ─┬─► M2 ─┬─► M4 ─┐
          │       └─► M5 ─┼─► M7
          └─► M3 ───► M6 ─┘

M7 ─► M8 ─► M9 ─► M10 ─► M11 ─► M12 ─► 1.0.0
```

M2 and M3 can proceed in parallel after M1. M8–M10 run in order: M8 settles the layers of ADR 0003,
so that each fix in M9 and each feature in M10 lands in the layer that owns it.

Each milestone keeps the affected component specifications current. Each milestone resolves the open
questions listed for it, either in the specification or, when the public API changes, in an RFC.

### M0: Engineering foundation

**Goal:** a workspace in which the components can be built and the ADR 0002 rules are enforced from
the first line of code.

- A workspace containing `packages/core`, with its four entry points (`contract`, `openapi`, the
  main entry, and `deno`) declared as package exports. Other packages are added by the milestone
  that needs them.
- TypeBox pinned to a 1.x minor version. A TypeBox upgrade re-runs the correctness suite and the
  type-performance baseline.
- A test layout that follows `AGENTS.md`: public tests under `tests/<package>/public/`, internal
  tests under `internal/`.
- An architecture test that enforces the import rules of ADR 0002 §3.
- A CI workflow that runs formatting, linting, type checking, and tests.
- `deno task verify` extended to the same checks.

**Exit criteria:**

- `deno task verify` and CI pass on an empty skeleton.
- The architecture test fails when a forbidden import is introduced.

### M1: Contract

**Goal:** the complete RFC 0001 declaration API, with types, normalization, and diagnostics.

- `defineApi`, `defineContract`, `defineSchema`, `defineResponse`, `defineSecurity`, the scheme
  constructors, `Problem`, and the inference types (input, result, and security types).
- `Handler`, `implement`, and `notImplemented`, so that the type contract can be tested in full (RFC
  0001 amendment A7).
- Normalization into `ContractModel`, and `checkContracts` with every diagnostic listed in the
  contract specification.
- The spike's findings applied: `NoInfer` in `implement` typing, `~kind` shorthand recognition, and
  path-parameter diagnostics that name the parameters.

**Open questions to resolve:** whether parameter `default` values change inferred input types; and
whether consumers need a type-only import.

**Outcome:** both open questions were resolved by RFC 0001 amendments A2 and A3–A7, and all exit
criteria are met. The `createApp` and verifier parts of the spike's correctness suite move to M2 and
M4.

**Exit criteria:**

- The spike's correctness suite runs as public type tests.
- Every diagnostic rule has a test.
- The type-performance baseline, re-run against the real implementation, stays within the RFC 0001
  targets.

### M2: Runtime request path

**Goal:** a working `createApp` that serves typed handlers with full validation, for operations
without security.

- `createApp`, including runtime handling of `notImplemented`.
- `problem()`.
- Routing with 404, 405 with `Allow`, and `HEAD` for `GET`.
- Parameter decoding for the v1 style subset.
- JSON bodies with 413, 415, and 400.
- TypeBox validation.
- Response status checks, field stripping, and the response-validation policy.
- Problem responses, `HttpError`, and request timeouts with the combined `AbortSignal`.
- An operation that declares a security requirement fails startup until M4. Security is never
  silently skipped.

**Open questions to resolve:**

- Option names and production defaults, including the response-validation policy.
- Trailing-slash policy and catch-all parameters.
- The problem `type` URI scheme.
- The asserted `format` set.
- Whether parameter defaults are applied.

**Outcome:** the open questions are resolved in the [runtime specification](components/runtime.md).
Public tests cover every framework error status, and the
[request-path baseline](baselines/request-path.md) is recorded.

**Exit criteria:**

- Public tests cover every step of the request flow and every framework error status.
- A request-path performance baseline is recorded under `_adr/baselines/`.

### M3: OpenAPI emission and CLI

**Goal:** the committed OpenAPI document as a deliverable.

- `emitOpenApi` and canonical JSON serialization.
- Named components and responses.
- `hyapi emit`, including `--check`.
- `hyapi doctor`.
- `hyapi new`, with a starter template.

**Open questions to resolve:**

- OpenAPI 3.1, 3.2, or both.
- Whether framework-generated problem responses are documented automatically.
- How the CLI locates contract modules.

**Outcome:** the decisions are recorded in the [openapi](components/openapi.md) and
[cli](components/cli.md) specifications: OpenAPI 3.1 only, declared responses only, configuration in
`deno.json`, and JSON or YAML output.

**Exit criteria:**

- Emitted documents validate against the OpenAPI schema.
- Emission is byte-identical across runs and platforms.
- A generated starter project passes its own verification, including `emit --check`.

### M4: Security

**Goal:** security requirements declared in contracts are enforced.

- Credential extraction for every v1 scheme type.
- Verifier invocation.
- OR/AND requirement evaluation and scope checks.
- 401 with `WWW-Authenticate`, and 403.
- Typed `ctx.security`.
- The M2 startup restriction is removed.
- `@hyapi/plugin-jwt`.

**Open questions to resolve:**

- Whether verifiers within one AND requirement run concurrently or in order.
- How verifier rejections are distinguished from internal errors.
- Whether `plugin-jwt` supports asymmetric algorithms in v1.

**Outcome:** verifiers run in declaration order and stop at the first failure. `null` means an
invalid credential, and a thrown error is an internal failure. `plugin-jwt` supports HS256, RS256,
ES256, and EdDSA through jose. See the [runtime](components/runtime.md) and
[plugins](components/plugins.md) specifications.

**Exit criteria:** public tests cover every scheme type, requirement combinations, and the scope and
failure classifications.

### M5: Lifecycle, hosting, and events

**Goal:** an application that starts, runs, reports, and stops predictably.

- Startup and shutdown hooks with rollback.
- `close()` with admission stop, drain, and abort.
- The health aggregator.
- Read-only operation events, including deprecated-operation usage.
- The opt-in document endpoint.
- `serve()` on Deno with graceful shutdown.

**Open questions to resolve:**

- Whether events carry the `Request`.
- Per-operation timeouts.
- Whether rc.5's shutdown timing rules still apply on Deno 2.9.

**Outcome:**

- Lifecycle resources are named.
- `createHealth` is standalone and reports draining.
- Events do not carry the `Request`.
- Per-operation timeouts are `createApp` options.
- Deno 2.9 still needs `--unstable-no-legacy-abort`.

See the [runtime](components/runtime.md) and [serve](components/serve.md) specifications. The
signal-driven shutdown test runs on Linux and macOS; Windows cannot deliver SIGTERM.

**Exit criteria:** tests cover startup rollback, bounded shutdown, signal-driven shutdown of a real
listener, and event delivery with failing listeners.

### M6: Evolution governance

**Goal:** breaking changes are detected, reviewed, and communicated.

- `@hyapi/openapi-diff` with its initial rule set.
- `hyapi diff`, with baseline resolution, acknowledgement of breaking changes, a pull-request
  summary, and machine-readable output.
- API changelog generation.

**Open questions to resolve:**

- Accepted input versions and external `$ref` support.
- The diff baseline and the acknowledgement mechanism.
- How the changelog is produced at release time.
- How the rule set relates to oasdiff.

**Outcome:**

- Inputs are OpenAPI 3.1 only.
- The diff baseline is the `main` branch.
- `--allow-breaking` acknowledges intended breaking changes.
- A HyAPI-defined set of 32 direction-aware rules.
- Markdown output serves as the API changelog.

See the [openapi-diff](components/openapi-diff.md) and [cli](components/cli.md) specifications.
Comparing against an earlier release for release notes remains open.

**Exit criteria:**

- Each rule has tests in both directions (request and response).
- The starter template's CI runs `hyapi diff`.

### M7: v1 release

**Goal:** a complete, documented, published v1.

- `@hyapi/plugin-oidc`, `@hyapi/plugin-cors`, `@hyapi/plugin-csrf`, and `@hyapi/plugin-rate-limit`.
- User documentation in `docs/`, an example application in `apps/example/`, and recipes (Prism
  mocking, an `openapi-fetch` client, and observability on top of events).
- The concrete security defaults in `SECURITY.md`.
- Release automation and a publish workflow.

**Plan:** M7 is delivered in three committed stages:

- **M7a:** the four plugins. Done.
- **M7b:** the example application, the VitePress user documentation, and recipes. Done:
  `apps/example` passes `emit --check` in `verify`, CI runs its `hyapi diff`, and `verify` builds
  the documentation, which checks for dead links.
- **M7c:** `SECURITY.md`, release automation, and the release-gate review. Done.

The first published version is `0.1.0`. The release gate below is the condition for `1.0.0`, after
early users have tried 0.x.

**Release gate:**

- Every milestone is complete, including M8–M10.
- No High finding of a review is open, and every other finding is resolved or explicitly deferred.
- No component specification has an open question marked as blocking v1.
- `deno task verify` and CI pass.
- The type-performance and request-path baselines are current.
- The example application's emitted document passes `emit --check` and `hyapi diff`.

### M8: Layered architecture

**Goal:** restructure Core to the layers of [ADR 0003](0003-layered-architecture.md) and enforce
them, before any fix or feature is added. Not released on its own; M8 and M9 together are `0.2.0`.

Findings: A1–A4, A6–A13, A15, A16.

- **L1 Contract:** custom formats declared in `defineApi({ formats })` and checked against the
  standard list (A1); the model deep-cloned and deep-frozen (A3); `checkContracts` split into pure
  steps (A6) and returning `{ ok, diagnostics }`; the model no longer exported (A9).
- **L2 Mechanisms:** `wire.ts` split into `params.ts` and `body.ts`, with a cancellable body reader
  (A11, A12); security returns a denial instead of a response (A8); lifecycle returns failures
  instead of emitting them; health becomes a pure aggregator without draining (A2).
- **L3 Request flow:** the pipeline returns an `Outcome` with every fact an event needs and emits
  nothing (A7).
- **L4 Application:** the only emitter of events and owner of state; registers formats with
  collision detection; `createApp` split into binding, plans, and drain tracking (A11); dead and
  duplicated surface removed (A13).
- **L5 Host:** `serve().finished` never rejects unhandled (A4).
- **Openapi and CLI:** `emitOpenApi(api)` with `ContractError`; the CLI and `doctor` use public
  functions and the emitted document.
- **Enforcement:** the architecture test checks the layer edges and the no-module-state rule;
  internal tests cover L2 modules (A10); a test pins TypeBox's hidden-marker behavior (A15);
  specifications updated (A16).

**Exit criteria:** the architecture test enforces ADR 0003 §4 and §5; RFC 0001 records the public
changes as amendments; the request-path baseline does not regress by more than 5%;
`deno task
verify` and CI pass.

### M9: Correctness and safe defaults

**Goal:** close the validation hole, the fail-open security default, and the remaining shutdown and
response gaps that Review 0001 confirmed. Released with M8 as `0.2.0`, because applications that
relied on the old behavior stop at startup.

Findings: F1, F2.1, A5, A14, F5.1, F5.6, F3.1–F3.3, F2.4, F2.5, F5.8.

- **Request bodies (F1):** startup fails when a non-JSON, non-text media type declares a schema
  other than a binary string, until form bodies are implemented.
- **Implicit public operations (F2.1):** a startup diagnostic when security schemes exist and an
  operation has no requirement at any level and no explicit `security: []`. Recorded as an RFC 0001
  amendment.
- **Streaming shutdown (F5.1):** open response bodies count as in flight, streams are aborted on
  shutdown, and resources stop after the listener drains. Raw `Response` is documented for streams
  (F5.6).
- **Response policy (A5):** header values are validated, and every response check follows
  `responseValidation`. The schema name `Problem` is reserved (A14).
- **Plugins and guides:** one canonical wrapper order, tested; CSRF skips preflight; `Vary: Origin`
  always; `exposeHeaders` documented and the example fixed (F3.1–F3.3); `plugin-jwt` requires
  `audience` (F2.5); the trust model for proxy headers and `x-forwarded-for` (F2.4, F5.8).

**Exit criteria:** each finding has a public test that failed before the fix; the specifications and
the guide describe the new behavior; `deno task verify` and CI pass.

### M10: Production features

**Goal:** the observability, authorization, and document features that production deployments need,
specified in an RFC before implementation. Planned as `0.3.0`; released as `0.2.5`.

Findings: F2.2, F2.3, F2.6, F2.7, F4, F5.2–F5.5, F5.7, F5.9.

- **Authorization:** a read-only `security.denied` event (F2.2); `requirement` in `VerifierContext`
  and documented `HttpError` from verifiers (F2.3); the apiKey challenge decided (F2.6); a recipe
  for central policy as typed handler wrappers (F2.7).
- **Observability:** opt-in request ID on events and responses, with an `AsyncLocalStorage` recipe
  (F5.2); errors with stack and cause on events (F5.3); a `request.unmatched` event (F5.4).
- **Several documents (F4):** `createApp({ documents })`; `serve` closes several apps or documents
  how; `hyapi.documents` in the CLI configuration, with per-document `emit`, `emit --check`, `diff`,
  and `doctor`, and `diff --document` and `--base`.
- **Limits and deployment:** per-operation body limits (F5.5); a deployment guide for Deno Deploy
  and containers, with liveness and readiness (F5.7); an HTTP load and memory baseline (F5.9).

**Plan:** M10 is delivered in three committed stages:

- **M10a:** authorization and observability (F2.2, F2.3, F2.6, F2.7, F5.2–F5.4), RFC 0001 A27–A32.
  Done.
- **M10b:** several documents (F4), RFC 0001 A33. Done.
- **M10c:** per-operation body limits, the deployment guide, and the HTTP load baseline (F5.5, F5.7,
  F5.9), RFC 0001 A34. Done. The baseline found and fixed a per-request memory leak.

**Exit criteria:** the example application uses the request ID, a denial event, and two documents
(public and internal); every new event is in the observability recipe; `deno task verify` and CI
pass.

### M11: Contract structure and base

**Goal:** organize `contract` by reader, move HyAPI's shared HTTP and TypeBox mechanisms into a
Core-internal base layer, and enforce a fixed interface between the contract compiler and its
consumers, as decided in [ADR 0004](0004-contract-structure-and-base.md). Released as `0.3.0`.

- **Base (L0):** `src/base/http.ts` (`HttpMethod`, media types, reason phrases) and
  `src/base/typebox.ts` (schema guard, component-name marker, `objectSchema`, `isRecord`,
  `snapshot`, `cloneSchema`, format lists), imported by `contract`, `openapi`, and `runtime` only.
- **Contract:** `declare/` (what applications write), `compile/` (the only interpreter), `model.ts`
  (the inner interface, owning the shared OpenAPI vocabulary and the parameter defaults that replace
  `LOCATIONS`), and `infer.ts`. `normalize_operation.ts` is split into operation, parameters, body,
  and responses; the security rules move into `compile/security.ts`; named schemas and responses
  share one registry in `compile/components.ts`.
- **Enforcement:** the layer and import tests learn `base/`; a new test limits `runtime/` and
  `openapi/` to `model.ts`, `compile/compile.ts`, `compile/diagnostics.ts`, and the types of
  `declare/` and `infer.ts`; a public API snapshot test compares every entry point's symbols with a
  committed snapshot.
- **Records:** ADR 0002 §1 and §3, ADR 0003 §1, §3, and §4, `components/contract.md`, a new
  `components/base.md`, and `AGENTS.md`, updated in the same change.

**Plan:** one pull request: the snapshot test first, then the moves, then the boundary tests and
records.

**Exit criteria:** the public API snapshot is unchanged; the example's `emit --check` passes, so the
emitted documents are byte-identical; diagnostic codes and messages are unchanged; no module outside
`compile/` imports a private compiler module; `deno task verify` and CI pass.

### M12: Narrow interfaces and deep modules

**Goal:** public and internal interfaces that hold only what users and other modules need, and
modules that each have one reason to change, as decided in
[Review 0002](reviews/0002-interfaces-and-module-depth.md). Released as `0.3.0`.

**Plan:** three committed stages, one pull request each:

- **M12a: internal structure** (I2, D1, D2, N1). Remove the ten unused internal exports and add an
  architecture test that every internal export is imported or re-exported by a public entry point;
  move the stateless parts of `runtime/app.ts` to `runtime/settings.ts` and `runtime/documents.ts`;
  move the response half of `runtime/pipeline.ts` to `runtime/respond.ts`; rename
  `runtime/binding.ts` to `runtime/startup.ts`, move `isRecord` and `Dict` out of `base/typebox.ts`,
  and rename `cli/src/document.ts` to `serialize.ts`. No public API change.
- **M12b: public interfaces** (I1, I3). Add the export rule to `AGENTS.md`; stop exporting the
  declaration shapes of I1; export one `FetchHandler` from `@hyapi/core`, used by `App.fetch` and
  the wrapper plugins; declare the JWT and OIDC verifier return types inline; remove `problem()`.
  Breaking; recorded as RFC 0001 amendments, with the public API snapshot, documentation, and
  example updated.
- **M12c: openapi-diff** (D3). Split `diff.ts` by area. No public API change.

**Exit criteria:** the internal-export test passes; no runtime module exceeds about 350 lines; every
public symbol in the snapshot meets the export rule; the example and documentation use no removed
symbol; `deno task verify` and CI pass.

## Open roadmap questions

- Whether pre-release versions (for example `0.x`) are published before M7, so that early users can
  try the contract and runtime after M3 or M5.

## Release-gate review (2026-10-09)

The gate below applies to `1.0.0`. This review records where the code stands at `0.1.0`.

| Gate                                                           | Status                                                                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every milestone is complete                                    | Met: M0–M7 are done.                                                                                                                                                   |
| No component specification has an open question that blocks v1 | Met: the remaining open questions are later goals, such as OpenAPI 3.0/3.2 input for `openapi-diff`, release-to-release changelogs, and non-JSON request bodies.       |
| `deno task verify` and CI pass                                 | Met: `verify` passes locally on Windows, and CI passed on Linux for PR #53 (175 tests, including the signal-shutdown test).                                            |
| The type-performance and request-path baselines are current    | Met: the type-performance check was re-run on 2026-10-09 (200 operations: 1.56 s; editor feedback 170–190 ms). The request-path path is unchanged since the M5 re-run. |
| The example passes `emit --check` and `hyapi diff`             | Met: `emit --check` runs in `verify`, and CI runs the example's `diff`.                                                                                                |

Before tagging `v0.1.0`: merge PR #53 to `main`, and then follow the release steps in
`CONTRIBUTING.md`.

[Review 0001](reviews/0001-component-and-production-readiness.md) (2026-10-09) found gaps that the
gate above did not cover: a request-body validation hole, a fail-open security default, and
process-global state in Core. ADR 0003 settles the layers first; the findings are scheduled as
M8–M10, which the 1.0.0 gate now includes. `0.1.0` can still be published as an early preview; its
release notes must name F1 and F2.1.
