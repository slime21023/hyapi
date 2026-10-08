# HyAPI

HyAPI is a contract-first API library for Deno. Contracts are written in TypeScript, agreed before
implementation, and compiled into OpenAPI 3.1 documents of delivery quality. Developers get native
types; consumers in any language get a faithful, stable, and governed OpenAPI document.

> **Redesign in progress.** The superseded `v1.0.0-rc.5` implementation has been removed; it remains
> available in git history. The new design is defined in
> [ADR 0001](_adr/0001-contract-first-api-library.md) and
> [ADR 0002](_adr/0002-architecture-and-component-boundaries.md). No code exists yet, and no version
> has been published to JSR.

## Records

Architecture decisions, component specifications, RFCs, baselines, and the roadmap live under
[`_adr/`](_adr/). Component specifications are indexed in
[`_adr/components/`](_adr/components/README.md), and the v1 milestones are in
[`_adr/roadmap.md`](_adr/roadmap.md).

## Development

```text
deno task verify      check formatting and lint
```

## License

[MIT](LICENSE)
