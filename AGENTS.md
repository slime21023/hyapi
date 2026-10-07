# HyAPI development guide

## Current status

HyAPI is being redesigned as a contract-first API library. The accepted direction is
[ADR 0001](_adr/0001-contract-first-api-library.md). The code under `packages/`, `apps/`, `tests/`,
`bench/`, and `scripts/`, and the user documentation under `docs/`, still implement and describe the
superseded `v1.0.0-rc.5` design. They will be replaced by later changes. Do not extend the
superseded API; follow the ADR for new work.

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
Contract tooling such as `emit` and `diff` belongs in `@hyapi/cli`.

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

- depend on `@hyapi/core` only through its public `mod.ts` API;
- expose a small explicit factory and typed options, with no global singleton;
- own its dependencies, tests, documentation, release cadence, and compatibility policy; and
- remain removable: Core and applications that do not select it must have no dependency on it.

Data stores, caches, queues, and business integrations remain application dependencies.

## Repository rules

- `packages/core/mod.ts` is the public Core boundary. Treat `packages/core/src/` as private.
- Place user-facing documentation in `docs/`. Keep ADRs, RFCs, migrations, baselines, and roadmap
  material in `_adr/`, numbered sequentially.
- Keep public contract tests under `tests/core/public/` and `tests/cli/public/`; they must import
  package facades, not private source files. Internal behavior tests belong under `internal/`.
- Keep benchmarks in `bench/` and examples in `apps/example/`; neither defines the public API.

Run the smallest relevant check while changing code, and run `deno task verify` before declaring a
cross-cutting change complete.
