# HyAPI development guide

## Product boundary

HyAPI is a small, structured HTTP API framework for Deno. Keep `@hyapi/core` limited to:

- application composition, routes, and HTTP request/response handling;
- request and response validation, error responses, and OpenAPI projection;
- cancellation, deadlines, lifecycle, and health-check orchestration; and
- narrow public extension points for modules, Ports, authentication, and plugins.

Do not add an ORM, database, cache, message queue, service discovery, default retry policy, global
rate limiter, or other infrastructure product to Core. These are application, host, or ecosystem
concerns—not unfinished framework features.

Keep TLS, CORS, WAF, compression, security headers, and global rate limiting at the reverse
proxy/edge or in an application-owned outer `fetch` wrapper. Do not introduce a general middleware
system merely to support them.

## Design rules

- Prefer Deno and Web Platform APIs before adding a dependency or wrapper.
- Make the direct implementation clear before introducing an interface, factory, registry, or layer.
  Delete indirection that has only one implementation or caller.
- Give each module one reason to change. Keep low-level modules small and policy-free; keep
  application orchestration in `app.ts` and application code.
- Depend on public contracts at boundaries. Do not expose or import Core internals to solve an
  extension problem.
- Use SOLID to clarify ownership and substitution, never as a reason to create speculative
  abstractions.
- Prefer explicit options and dependency injection. Avoid global state, hidden defaults, and
  automatic behavior that changes network or security policy.

## Optional integrations

Provide a recipe using an established ecosystem package before creating an official plugin. Add a
plugin package only for a repeated, well-defined integration that the public Core API can already
support.

An optional plugin must:

- depend on `@hyapi/core` only through its public `mod.ts` API;
- expose a small explicit factory and typed options, with no global singleton;
- own its dependencies, tests, documentation, release cadence, and compatibility policy; and
- remain removable: Core and applications that do not select it must have no dependency on it.

Examples that may become independent plugins when needed are OIDC/JWKS authentication and
OpenTelemetry or metrics exporters. Data stores, caches, queues, and business integrations remain
application dependencies.

## Repository rules

- `packages/core/mod.ts` is the public Core boundary. Treat `packages/core/src/` as private.
- Place user-facing documentation in `docs/`; keep ADRs, RFCs, migrations, baselines, and roadmap
  material in `_design/`.
- Keep public contract tests under `tests/core/public/` and `tests/cli/public/`; they must import
  package facades, not private source files. Internal behavior tests belong under `internal/`.
- Keep benchmarks in `bench/` and examples in `apps/example/`; neither defines the public API.

Run the smallest relevant check while changing code, and run `deno task verify` before declaring a
cross-cutting change complete.
