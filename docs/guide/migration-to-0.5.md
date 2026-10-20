# Migrate to 0.5.0

HyAPI 0.1.x–0.4.x were internal milestones, not prior npm releases in this release line. The 0.5.0 source tree exposes one facade, `hyapi`, without an `@hyapi/core` alias. Local builds and tarballs do not establish npm publication; check the registry before moving an external dependency to it.

## From older `@hyapi/core` APIs

- Replace `@hyapi/core` imports and dependencies with `hyapi` (`"hyapi": "workspace:*"` inside this checkout); remove stale lockfile entries. Do not import private Core source paths. The example stays private; the old CLI/plugins do not migrate as packages.
- Replace old module route DSLs, `defineConfig`, `serve`, HTTP clients/contracts, lifecycle hooks, health APIs, plugin integration, and generated OpenAPI with the explicit 0.5.0 modules and application-owned integrations. No aliases or compatibility adapters are exported.

## From this checkout's Elysia-native API

This is also a **breaking** change from `createApplication`, `defineModule`, named Ports (`definePort`, `providePort`), `guarded`, `defineGuard`, `authorizeGuard`, `identityFor`, `allOf`, and `anyOf`. Those exports and consumer-facing Elysia route plugins are gone. Do not merely rename the import:

| Before                                                      | 0.5.0                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `await createApplication({ providers, modules })`           | `createApp({ container, modules: ({ module }) => [...] })`                                      |
| `defineModule(name, requires, () => new Elysia().get(...))` | `module({ name, prefix, routes: (route) => [route.get(path, { handler, ...schemas })] })`       |
| `providePort(port, factory, { scope: "request" })`          | Register dependencies on an InferDI root; opt into `scoped: true` and use `scope.get(...)`      |
| `guarded(prefix, guard, plugin)` and `identityFor(request)` | `module({ prefix, authenticate(request, root), routes })` and typed `identity` in route context |
| `authorizeGuard(guard)` / Elysia `beforeHandle`             | Route-local `authorize(context)` after validation                                               |
| Elysia `t` route schemas / application-owned schema mirror  | Standard Schema (Valibot directly); configure `openapi` explicitly                              |
| External Elysia listener + Core `app.fetch`                 | `await app.listen({ port, hostname?, fetch? })` or `app.fetch(request)`                         |

For example, replace a protected route plugin with an InferDI-backed module:

```ts
import { Container } from "@inferdi/inferdi";
import { createApp, UnauthorizedError } from "hyapi";
import * as v from "valibot";

const container = new Container().registerValue("greeting", "Hello");
const app = createApp({
  container,
  modules: ({ module }) => [
    module({
      name: "greetings",
      prefix: "/greetings",
      authenticate(request) {
        const subject = request.headers.get("x-subject");
        if (!subject) throw new UnauthorizedError();
        return { subject };
      },
      routes: (route) => [
        route.get("/:name", {
          params: v.object({ name: v.string() }),
          response: v.object({ message: v.string() }),
          handler: ({ params, identity, root }) => ({
            message: `${root.get("greeting")}, ${params.name} from ${identity.subject}`,
          }),
        }),
      ],
    }),
  ],
});
```

`authenticate(request, root)` runs before validation; route-local `authorize(context)` sees validated input. Scopes are lazy and opt-in, with authenticated identity as an InferDI scope input when one is created. For alternate statuses declare a numeric response map and return `reply(status, value)`; use native `Response` for streams. On shutdown call `await app.close()`, then `await container.dispose()` and close any `registerValue` resources yourself. OpenAPI is disabled unless `openapi: { path, info, ... }` is passed; Valibot converts automatically, while other schema vendors require `openapi.converters` to supply JSON Schema at startup. Protected modules documented via OpenAPI must name a declared security scheme.

## Update the ERP example

- `buildExampleApp(secret)` becomes `buildExampleApp({ jwtSecret, databaseUrl })`. Supply both explicitly as `JWT_SECRET` and `DATABASE_URL`; no implicit `.env` loading. The application creates `hyapi_example_users`, `hyapi_example_inventory`, and `hyapi_example_orders` in PostgreSQL on startup. In-memory data does not migrate automatically; migrate real data with reviewed SQL before cutover.
- An authenticated `POST /v1/users/` creates a subject-owned user. `POST /v1/inventory/` requires signed admin role and `sku`/nonnegative `quantity`. `POST /v1/orders/` requires an existing owned user, `sku`, and positive quantity; missing stock returns 404, insufficient stock 409 without committing an order or decrement. UUID route parameters are validated.
- Probe `/health/ready` for dependency readiness and `/health/live` for process liveness. The explicitly configured `/openapi/json` includes public and protected routes; `/health/stream` owns its timer through completion/cancellation. Shutdown stops the listener, closes the app, disposes the InferDI root, and closes PostgreSQL. Request logging uses the optional `listen({ fetch: tracedFetch })` wrapper, not a Core global logger.

See [Getting Started](/guide/getting-started) and [Operations](/guide/operations) for running the example. Release automation's local dry run cannot prove npm ownership or publication.
