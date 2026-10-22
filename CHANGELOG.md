# Changelog

All notable changes to HyAPI are documented here. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - Unreleased (first planned npm release)

### Added

- Declarative `createApp({ container, modules: ({ module }) => [...] })` with typed route callbacks, module authentication before validation, and route-local authorization after validation.
- Standard Schema request/response validation, Valibot OpenAPI conversion, optional `openapi: { path, info, ... }` JSON endpoint, and required converters for other schema vendors when OpenAPI is enabled.
- Lazy, opt-in InferDI scopes via `scoped: true` and `scope.get(...)`; `reply(status, value)` for declared response statuses and native `Response` streaming.
- Built-in Bun/Node `app.listen(...)`, direct `app.fetch(...)`, and optional application-owned listener fetch wrapper for logging.
- `app.close({ timeoutMs })` bounds the caller's shutdown wait without cancelling accepted handlers; the example entry point uses a 10-second deadline.
- A `reply` status missing from a declared `response` contract fails with a private 500 instead of skipping response validation.
- `documented: false` omits a route from OpenAPI, so routes with schemas that have no JSON Schema form (for example file uploads) no longer block documented startup.
- Routes accept a unique `operationId` for OpenAPI operations; duplicates or empty IDs reject composition.
- `reply(status, value, { headers })` sends response headers such as `Location` or multiple `Set-Cookie` values with a schema-validated body; they are dropped when the response fails.
- Request `VALIDATION_ERROR` responses list each failed rule in `errors` as `{ in, pointer, message }`, using the route's own Standard Schema issues and RFC 6901 JSON Pointers.
- `createApp({ onError })` observes every private 500 with its original error and request, without awaiting it or letting it change the response.
- PostgreSQL-backed single-tenant Users, Inventory, and Orders reference; purchase and stock deduction share a transaction, with missing-stock 404, insufficient-stock 409, and owner/admin authorization.
- Example `/health/live`, PostgreSQL-backed `/health/ready`, `/health/stream`, and explicit `/openapi/json`.

### Security

- Requests whose host is shorter than the internal router's fixed path offset (for example `Host: l`) now fail with 400 `UNROUTABLE_REQUEST`. Previously the router matched a suffix of the real path, so a client-controlled `Host` header could reach a protected handler without authentication on Bun and Node.
- Modules with prefix `/` now register `/health` instead of `//health`. Previously their non-root routes answered only on a doubled slash, which also skipped a protected root module's authentication (`GET //admin` reached the handler) and documented `//`-prefixed OpenAPI paths.

### Changed

- **Breaking package and API cutover:** `hyapi@0.5.0` is the only planned publishable package. Remove `@hyapi/core`, `createApplication`, `defineModule`, Ports/providers, Elysia route plugins, `guarded`, and guard combinators. No compatibility aliases are exported. Historical `core-v*` and versions below 0.5.0 cannot publish.
- The caller owns the InferDI root and cleanup of `registerValue` resources after `app.close()`; Core drains accepted handlers and stops listeners but does not dispose the root.
- The example requires explicit `{ jwtSecret, databaseUrl }` configuration and PostgreSQL rather than in-memory stores. No implicit environment loading or edge policy is installed.
- Removed obsolete CLI/plugin build artifacts and empty source/test scaffolds; Core and example target Node 24 and Bun.
- Store the `hyapi` version in `packages/core/package.json`; keep implementation files directly under version-independent `packages/core/src/`.
- Removed the old user guides, VitePress site, and documentation-only toolchain.
- Restructured the private ERP example into explicit authentication and business modules; Orders composes Inventory stock reservation and order creation within one PostgreSQL transaction.

`bun run verify` and a matching `hyapi-v0.5.0` dry run check local source and tarballs. This entry remains **unreleased** until npm ownership, credentials, actual publication, and a published-package consumer are verified.

## [0.1.0] - Unreleased

### Added

- `@hyapi/core` facade for Elysia-native `createApplication`, `defineModule`, named Ports and providers with application and request lifetimes, and deterministic cleanup.
- `guarded()` for mount-level authentication before parsing and validation; `authorizeGuard()` for route-local authorization after validation; `identityFor()`, `defineGuard()`, `allOf()`, and `anyOf()` for guard composition.
- `HttpError`, `UnauthorizedError`, `ForbiddenError`, and `problemHandler()` for `application/problem+json` responses.
- Users and Orders example with HS256 Bearer authentication, resource ownership checks, and Bun/Node listener adapters.

### Changed

- **Breaking clean cutover:** Core uses Elysia 1.4.30 routes and schemas directly. The previous module route DSL, `defineConfig`, `serve`, HTTP contracts/clients, lifecycle hooks, health APIs, generated OpenAPI, and old plugin integration are not exported in v0.1. Migrate callers to the v0.1 facade and Elysia-native APIs; there are no compatibility shims.
- The v0.1 workspace contains Core and the example only. The previous CLI and five plugins do not support this API and are not v0.1 publication targets.
- Bun 1.4 is the development package manager; compiled Core and the example target Node 24 as well as Bun. The example requires an explicitly injected `JWT_SECRET` of at least 32 UTF-8 bytes; no implicit `.env` loading.
- OpenAPI is not generated by Core. Elysia-native documentation is application-owned; protected child routes mounted through `guarded()` are opaque to a parent Elysia OpenAPI generator.

The previous rc.5 release candidate and earlier releases describe historical APIs and are not compatible with v0.1. Local build and pack checks do not establish npm publication.
