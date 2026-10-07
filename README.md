# HyAPI

HyAPI is a structured, type-safe API framework for Deno. It uses TypeBox route contracts, explicit
module Ports, native Web APIs, and deterministic lifecycle boundaries.

> **Redesign in progress.** HyAPI is being rebuilt as a contract-first API library: contracts are
> written in TypeScript, agreed before implementation, and compiled into OpenAPI 3.1 documents of
> delivery quality. See [ADR 0001](_adr/0001-contract-first-api-library.md). The code and
> documentation below describe the superseded `v1.0.0-rc.5` design.

## Documentation

Read the English [usage guide](docs/index.md) for application setup, routes, composition,
configuration, HTTP/OpenAPI, optional plugins, and operations.

Architecture decisions, RFCs, baselines, and the roadmap are internal project records under
[`_adr/`](_adr/).

## Workspace

```text
packages/core               framework package (@hyapi/core)
packages/cli                project generator and diagnostics (@hyapi/cli)
packages/plugin-cors        optional CORS HTTP wrapper
packages/plugin-csrf        optional signed double-submit CSRF wrapper
packages/plugin-jwt         optional HS256 JWT Bearer authentication guard
packages/plugin-oidc        optional OIDC Bearer authentication guard
packages/plugin-rate-limit  optional local rate-limit HTTP wrapper
apps/example                example API
tests/                      workspace tests
bench/                      workspace benchmarks
docs/                       VitePress user documentation
_adr/                       architecture decisions and project records
```

## Development

```text
deno task dev         run the example API
deno task verify      run every quality check and build the docs
deno task bench       run benchmarks
deno task docs:dev    preview the documentation locally
```

`v1.0.0-rc.5` is superseded by the redesign and will not be published. No JSR publication has
occurred.

## License

[MIT](LICENSE)
