# HyAPI roadmap

- Status: living document. Update a milestone's status when its exit criteria are met.
- Date: 2026-10-08
- Basis: [ADR 0001](0001-contract-first-api-library.md),
  [ADR 0002](0002-architecture-and-component-boundaries.md),
  [RFC 0001](rfcs/0001-contract-and-handler-api.md), and the
  [component specifications](components/README.md)

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

| Milestone                              | Goal                                                 | Components        | Depends on | Status            |
| -------------------------------------- | ---------------------------------------------------- | ----------------- | ---------- | ----------------- |
| [M0](#m0-engineering-foundation)       | Engineering foundation                               | repository        | —          | Done (2026-10-08) |
| [M1](#m1-contract)                     | Contracts, inference, normalization, diagnostics     | contract          | M0         | Done (2026-10-08) |
| [M2](#m2-runtime-request-path)         | Runtime request path without security                | runtime           | M1         | Done (2026-10-08) |
| [M3](#m3-openapi-emission-and-cli)     | OpenAPI emission and the contract CLI                | openapi, cli      | M1         | Done (2026-10-08) |
| [M4](#m4-security)                     | Security evaluation and the JWT verifier             | runtime, plugins  | M2         | Done (2026-10-08) |
| [M5](#m5-lifecycle-hosting-and-events) | Lifecycle, hosting, health, and events               | runtime, serve    | M2         | Done (2026-10-08) |
| [M6](#m6-evolution-governance)         | Evolution governance                                 | openapi-diff, cli | M3         | Done (2026-10-08) |
| [M7](#m7-v1-release)                   | Remaining plugins, documentation, and the v1 release | plugins, all      | M4, M5, M6 | Not started       |

```text
M0 ─► M1 ─┬─► M2 ─┬─► M4 ─┐
          │       └─► M5 ─┼─► M7
          └─► M3 ───► M6 ─┘
```

M2 and M3 can proceed in parallel after M1.

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

**Release gate:**

- Every milestone is complete.
- No component specification has an open question marked as blocking v1.
- `deno task verify` and CI pass.
- The type-performance and request-path baselines are current.
- The example application's emitted document passes `emit --check` and `hyapi diff`.

## Open roadmap questions

- Whether pre-release versions (for example `0.x`) are published before M7, so that early users can
  try the contract and runtime after M3 or M5.
