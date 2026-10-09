# HyAPI development guide

## Current status

HyAPI is a contract-first API library, built to [ADR 0001](_adr/0001-contract-first-api-library.md),
[ADR 0002](_adr/0002-architecture-and-component-boundaries.md),
[ADR 0003](_adr/0003-layered-architecture.md), and
[RFC 0001](_adr/rfcs/0001-contract-and-handler-api.md). Progress is tracked in
[`_adr/roadmap.md`](_adr/roadmap.md), and each component's current behavior is specified in
`_adr/components/`. The superseded `v1.0.0-rc.5` design remains only in git history; do not restore
or port it.

## Product boundary

HyAPI contracts are written in TypeScript, agreed before implementation, and compiled into OpenAPI
3.1 documents of delivery quality. Keep `@hyapi/core` limited to:

- declaring contracts (`operationId`-keyed operations with TypeBox schemas) and binding their
  implementations by `operationId`;
- routing, parameter deserialization, request validation, response shaping and validation, and RFC
  9457 problem+json errors;
- evaluating the contract's security requirements through application-supplied verifiers;
- compiling contracts into a deterministic OpenAPI 3.1 document; and
- cancellation, timeouts, lifecycle, health-check aggregation, and read-only operation events.

The contract is the only source of truth, and handler types are inferred from it. Do not add YAML or
JSON documents as input, code generation of types or handlers, schema libraries other than TypeBox,
contract constructs that cannot be represented in JSON Schema, handler resolution from strings or
module paths, or routes the contracts do not declare except through explicit opt-in options.
Contract tooling such as `emit` and `doctor` belongs in `@hyapi/cli`; OpenAPI change classification
belongs in `@hyapi/openapi-diff`, which depends on no HyAPI package.

Do not add an ORM, database, cache, message queue, service discovery, default retry policy, global
rate limiter, or other infrastructure product to Core. These are application, host, or ecosystem
concerns—not unfinished framework features.

Keep TLS, CORS, WAF, compression, security headers, and global rate limiting at the reverse
proxy/edge or in an outer `fetch` wrapper. Do not introduce a general middleware system, mutable
request/response hooks, or a Core plugin interface.

## Design rules

- Prefer Deno and Web Platform APIs before adding a dependency or wrapper. Core uses only
  Web-standard APIs; Deno-specific helpers such as `serve()` stay thin and separate.
- Do not generate code at runtime with `eval` or `new Function` in HyAPI's own code. Validation
  relies on TypeBox, which compiles where evaluation is allowed and falls back otherwise.
- Fail at startup, with every diagnostic reported together, rather than silently ignoring an
  unsupported keyword, parameter style, handler, or security scheme.
- Make the direct implementation clear before introducing an interface, factory, registry, or layer.
  Delete indirection that has only one implementation or caller.
- Give each module one reason to change. Keep low-level modules small and policy-free; keep
  application orchestration in `app.ts` and application code.
- Depend on public contracts at boundaries. Do not expose or import Core internals to solve an
  extension problem.
- Use SOLID to clarify ownership and substitution, never as a reason to create speculative
  abstractions.
- Prefer explicit options and dependency injection by closure. Avoid global state, hidden defaults,
  and automatic behavior that changes network or security policy.

## Optional integrations

Provide a recipe using an established ecosystem package before creating an official plugin. Add a
plugin package only for a repeated, well-defined integration that the public Core API can already
support. An official plugin takes one of two shapes:

- a **security verifier** that the application registers under a `securitySchemes` name, such as JWT
  or OIDC/JWKS verification; or
- an **outer `fetch` wrapper** of the form `(fetch, options) => fetch`, such as CORS, CSRF, or
  single-instance rate limiting.

An optional plugin must:

- depend on `@hyapi/core` only through its public entry points;
- expose a small explicit factory and typed options, with no global singleton;
- own its dependencies, tests, documentation, release cadence, and compatibility policy; and
- remain removable: Core and applications that do not select it must have no dependency on it.

Data stores, caches, queues, and business integrations remain application dependencies.

## Repository rules

- The public Core boundary is the four entry points defined in
  [ADR 0002](_adr/0002-architecture-and-component-boundaries.md): `@hyapi/core/contract`,
  `@hyapi/core/openapi`, `@hyapi/core`, and `@hyapi/core/deno`. Treat `packages/core/src/` as
  private.
- Respect the layers of ADR 0003: a module never imports a higher layer, only the application layer
  (`runtime/app.ts`) owns mutable state and emits events, and no module in `packages/core/src/`
  keeps mutable state at module scope.
- Contracts are interpreted only once, in the contract component's internal `ContractModel`. The
  runtime and the OpenAPI emitter consume that model, never raw declarations, and never import each
  other. The contract component never imports runtime, OpenAPI, or Deno host code.
- Place user-facing documentation in `docs/`. Keep ADRs, RFCs, migrations, baselines, and roadmap
  material in `_adr/`, numbered sequentially. Keep component specifications in `_adr/components/`
  and update them in the same change as the code they describe.
- Keep public contract tests under `tests/core/public/` and `tests/cli/public/`; they must import
  package facades, not private source files. Internal behavior tests belong under `internal/`.
- Keep benchmarks in `bench/` and examples in `apps/example/`; neither defines the public API.

Run the smallest relevant check while changing code, and run `deno task verify` before declaring a
cross-cutting change complete.
