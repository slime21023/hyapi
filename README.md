# HyAPI

HyAPI is a structured, type-safe API framework for Deno. It uses TypeBox route contracts, explicit
module Ports, native Web APIs, and deterministic lifecycle boundaries.

## Documentation

Read the English [usage guide](docs/index.md) for application setup, routes, composition,
configuration, HTTP/OpenAPI, optional plugins, and operations.

Architecture decisions, RFCs, migrations, quality rules, benchmarks, and the roadmap are internal
project records under [`_design/`](_design/).

## Workspace

```text
packages/core               framework package (@hyapi/core)
packages/cli                project generator and diagnostics (@hyapi/cli)
packages/plugin-cors        optional CORS HTTP wrapper
packages/plugin-csrf        optional signed double-submit CSRF wrapper
packages/plugin-oidc        optional OIDC Bearer authentication plugin
packages/plugin-rate-limit  optional local rate-limit HTTP wrapper
apps/example                example API
tests/                      workspace tests
bench/                      workspace benchmarks
docs/                       VitePress user documentation
_design/                    architecture and project records
```

## Development

```text
deno task dev         run the example API
deno task verify      run every quality check and build the docs
deno task bench       run benchmarks
deno task docs:dev    preview the documentation locally
```

The current candidate is `v1.0.0-rc.4`. No JSR publication has occurred.

## License

[MIT](LICENSE)
