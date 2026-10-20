# Bun-managed npm workspace migration

This pre-1.0 migration replaces the previous runtime and package-manager contract without keeping
compatibility aliases. Historical design records are unchanged. The seven package manifests retain
`1.0.0-rc.5`; no npm publication is verified or performed by this migration.

## Runtime and package boundary

Use Node 24+ for consumers and Bun 1.4.0 for workspace installation, development, tests, and
packaging. `bun.lock` is the only lockfile. Install with `bun install --frozen-lockfile`, build with
`bun run build`, and run the complete gate with `bun run verify`.

Import `@hyapi/core` and the optional plugin package facades by their npm names. Package exports
resolve to built ESM and declarations, not raw TypeScript. Core's `mod.ts` defines its source facade;
`src/` is private and is not an importable package subpath. There is one Node-compatible HTTP
listener, not separate Node and Bun packages. Consumers running built JavaScript on Node do not
need Bun.

## Listener API changes

`serve()` now returns `Promise<HyServer>` and resolves only after binding:

```ts
import { serve, type ServerAddress } from "@hyapi/core";

const server = await serve(app, {
  port: 8000,
  shutdownSignals: ["SIGINT", "SIGTERM"],
  onListen(address: ServerAddress) {
    console.log(address.hostname, address.port);
  },
});
await server.finished;
```

Await every call before accessing `addr`, `shutdown()`, or `finished`. `HyServer.addr` and
`onListen` use `ServerAddress`, containing `hostname` and `port` without a `transport` field.
`ShutdownSignal` is a public string union with no runtime namespace dependency. Only requested
shutdown signals are installed; Windows supports `SIGINT` and `SIGBREAK`.

Use `await serve(app, { fetch: handler })` for an application-owned outer HTTP wrapper. Keep wrapper
order and explicit CORS, CSRF, and rate-limit policy unchanged. The first argument still owns
application cleanup. This is not a middleware system and does not move optional infrastructure
into Core.

## Environment and CLI changes

The example's environment key is `NODE_ENV`, with `development`, `test`, and `production` accepted.
Its default remains `development`; Core's explicit configuration still defaults to `production`.
Read `process.env` at the entry point and pass values to application composition. In particular,
`buildExampleApp()` receives JWT issuer/audience through its options rather than reading process
state. `JWT_SECRET`, `HOST`, and `PORT` retain their roles.

The workspace and generated starters disable implicit `.env` loading. Inject environment variables
through the invoking process, or explicitly select a file, for example
`bun --env-file=.env run dev` or `node --env-file=.env apps/example/dist/main.js`.

CLI project markers are now `package.json`. Inspection JSON renames `hasDenoConfig` to
`hasPackageJson` with no old alias; the missing-config finding code remains `PROJECT_CONFIG_MISSING`.
Starters generate `package.json`, `tsconfig.json`, and `bunfig.toml`, with Bun-managed scripts,
NodeNext compilation, and one Node-compatible test suite runnable in both runtimes. CLI `new` does
not install dependencies; follow its `bun install` and `bun run verify` instructions. Generated
modules still require manual registration in `src/app.ts`.

The CLI executable runs on Node or Bun and obtains its version from its manifest. The manifest's
`hyapi.starterCoreVersion` separately declares the Core range used in generated projects; CLI and
Core versions no longer imply one another.

## Independent releases and evidence

Each package can release independently using its own exact manifest version and qualified tag,
such as `core-v1.0.0-rc.5` or `cli-v1.0.0-rc.5`. The old unqualified tag shape is rejected. See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for dry-run, registry preflight, token, and dist-tag rules.
Local tarball consumers and generated starter verification do not prove that a version exists on
npm. Formal releases resolve peers from npm and require compatible Core to be available for
Core-dependent plugins and CLI starters.

Historical performance baselines used a different runtime and are not comparable to current Bun or
Node results. Establish like-for-like measurements before asserting a regression or speedup.
