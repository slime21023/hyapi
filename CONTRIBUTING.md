# Contributing to HyAPI

Use Node 24+ and Bun 1.4.0. Bun manages the workspace; commit `bun.lock`, not npm or pnpm lockfiles. The workspace contains the single publishable `hyapi` package at `packages/core` and a private `apps/example`. Import `hyapi` through `packages/core/mod.ts`, never a private `src/` subpath. Old CLI/plugin packages are not release targets.

## Development

```text
bun install --frozen-lockfile
bun run verify
```

`verify` runs build, format checks, type-aware oxlint (Google TypeScript Style Guide rules plus `no-floating-promises`; naming is checked in review), type checks, Bun and Node tests, a local packed consumer, and package checks. Tests require a reachable PostgreSQL 16 database via `DATABASE_URL`; tests create and clean unique fixtures. CI provisions PostgreSQL on Linux and Windows. Local packed checks cannot prove registry publication.

For local development, supply `DATABASE_URL` and a cryptographically random `JWT_SECRET` of at least 32 UTF-8 bytes, then run `bun run dev`. To run built ESM, use `bun run build` followed by `bun run start` or `node apps/example/dist/main.js`. `HOST` and `PORT` are optional; the example does not implicitly load `.env`. To opt in, use `bun --env-file=.env run dev` or `node --env-file=.env apps/example/dist/main.js`.

Text files use LF line endings on Windows and Unix checkouts.

## Documentation

The English official website lives in `docs/` and uses VitePress:

```sh
bun run docs:dev
bun run docs:build
bun run docs:preview
```

The README Quickstart is included into the site from a single source; import existing example code rather than copying it into separate guides. Version 0.5.0 is unreleased: examples must work from this checkout, not assume an npm install. When a public behavior changes, recheck the affected snippets and build the site before handing off.

## Changes and releases

Keep changes focused and update retained project notes and behavior tests alongside public API changes. Modules declare routes through a `routes: (route) => [...]` callback in `createApp({ container, modules: ({ module }) => [...] })`; do not restore the old Ports/Elysia plugin API or publish the old CLI/plugins as compatible. `_design/` migrations remain historical.

Before a release, run `bun install --frozen-lockfile` and `bun run verify` with `DATABASE_URL`, inspect the single-package tarball, then run `bun scripts/release.ts hyapi-v0.5.0 --dry-run`. Publication uses only a matching stable `hyapi-v<version>` tag at or above 0.5.0, an available npm name, and `NPM_CONFIG_TOKEN`; old `core-v*` tags cannot publish. After publication, install the actual npm version in an external consumer and exercise declarations and HTTP on Bun and Node 24. Never commit credentials.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
