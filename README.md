# HyAPI

HyAPI is a contract-first API library for Deno. Contracts are written in TypeScript, agreed before
implementation, and compiled into OpenAPI 3.1 documents of delivery quality. Developers get native
types; consumers in any language get a faithful, stable, and governed OpenAPI document.

> **Status:** pre-release. Every v1 component is implemented and tested; the first published version
> will be `0.1.0`. The design is defined in [ADR 0001](_adr/0001-contract-first-api-library.md) and
> [ADR 0002](_adr/0002-architecture-and-component-boundaries.md); progress is in the
> [roadmap](_adr/roadmap.md).

## Packages

| Package                                                                | Purpose                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@hyapi/core`                                                          | Contracts (`/contract`), the runtime, OpenAPI emission (`/openapi`), and `serve` (`/deno`) |
| `@hyapi/cli`                                                           | `new`, `emit`, `doctor`, and `diff`                                                        |
| `@hyapi/openapi-diff`                                                  | Breaking-change classification for any OpenAPI 3.1 document                                |
| `@hyapi/plugin-jwt`, `@hyapi/plugin-oidc`                              | Security verifiers                                                                         |
| `@hyapi/plugin-cors`, `@hyapi/plugin-csrf`, `@hyapi/plugin-rate-limit` | Outer `fetch` wrappers                                                                     |

## Documentation

The user guide is in [`docs/`](docs/index.md); preview it with `deno task docs:dev`. The
[example application](apps/example/) uses every feature.

## Records

Architecture decisions, component specifications, RFCs, baselines, and the roadmap live under
[`_adr/`](_adr/). Component specifications are indexed in
[`_adr/components/`](_adr/components/README.md), and the v1 milestones are in
[`_adr/roadmap.md`](_adr/roadmap.md).

## Development

```text
deno task verify      format, lint, type-check, test, check the example's document, build docs
deno task bench       run the request-path benchmarks
deno task docs:dev    preview the documentation
```

## License

[MIT](LICENSE)
