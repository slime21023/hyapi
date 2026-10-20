# HyAPI development guide

## Product boundary

HyAPI is a small Elysia-native HTTP API framework, developed with Bun 1.4 and published as one npm
package, `hyapi`, for Node 24+ and Bun consumers of built ESM. Keep Core limited to application
composition, Ports, guards, HTTP behavior, and narrow extension contracts. Keep PostgreSQL,
transactions, telemetry exporters, and edge policy in the application or host—not in Core.

Keep TLS, CORS, WAF, compression, security headers, and global rate limiting at the reverse
proxy/edge or in an application-owned outer `fetch` wrapper. Do not introduce a general middleware
system merely to support them.

## Design rules

- Prefer Node-compatible standard-library and Web Platform APIs before adding a dependency or wrapper.
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

## Application-owned integrations

Use established ecosystem packages in the application before considering a new integration.
The private example owns its PostgreSQL adapter, OpenAPI assembly, and operational recipes;
Users, Orders, and Inventory are modules inside that application, not separately published packages.
Do not create CLI or plugin packages as part of the `hyapi` release.

## Repository rules

- `packages/core/mod.ts` defines the public `hyapi` facade, exposed by its `package.json` through
  built JavaScript and declarations. Consumers import `hyapi`; `packages/core/src/` is private.
- Place user-facing documentation in `docs/`; keep ADRs, RFCs, migrations, baselines, and roadmap
  material in `_design/`.
- Keep public contract tests under `tests/core/public/`; they must import the package facade,
  not private source files. Internal behavior tests belong under `internal/`.
- Keep benchmarks in `bench/` and examples in `apps/example/`; neither defines the public API.

Use Bun 1.4.0 for installation, development, tests, and packaging, with `bun.lock` as the only
lockfile. Run `bun run verify` before declaring a cross-cutting change complete. Keep environment
injection explicit; do not introduce implicit `.env` loading. Only `hyapi` is published; 0.1.x
through 0.4.x are internal milestones, and `hyapi-v0.5.0` is the first public release tag.
