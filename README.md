# HyAPI

HyAPI is a structured, type-safe API framework for Deno. It synthesizes the best design ideas from
Hapi (deterministic lifecycle hooks, explicit route contracts, fail-fast configuration, plugin
isolation) and Egg.js (layered engineering structure, hierarchical route grouping), built entirely
on top of Web Standards and TypeBox. Hono is used internally for routing and is not part of the
public API.

## Current status

HyAPI is currently at **v1.0.0-rc.2**, the audit-remediation release candidate. Its public API is
frozen; only test coverage, repeatable performance/security evidence, and documentation corrections
are in scope before v1.0.0.

Read the [roadmap](docs/roadmap.md), [v1.0.0 migration guide](docs/migrations/v1.0.0.md),
[changelog](CHANGELOG.md), [contribution/release policy](CONTRIBUTING.md),
[security policy](SECURITY.md), [operations guide](docs/operations.md), and
[performance baseline](docs/baselines/performance.md).

## Key Features

- **Schema-Driven Contracts**: TypeBox schemas derive both static TypeScript types and native JIT
  validation with zero external validator dependencies.
- **Hierarchical Route Groups (`module.group`)**: Nested path prefixes, OpenAPI tags, auth scope
  union inheritance, and group-scoped lifecycle hooks.
- **Multi-Format Request Body Parsing**: Automatic Content-Type parsing for `application/json`,
  `application/x-www-form-urlencoded`, and `multipart/form-data`.
- **OpenAPI 3.1 & RFC 7807 Out of the Box**: Native multi-status response schemas, accurate
  `bearerAuth` scope mapping, optional authentication support, and standardized Problem Details.
- **Plugin Dependency Graph (DAG) & Graceful Shutdown**: Plugins can be composed in any order and
  are automatically topologically sorted, supporting `setup`, `onStart`, and `onClose` lifecycle
  hooks.
- **Semantic Context API**: High-ergonomics response helpers (`ctx.ok()`, `ctx.created()`,
  `ctx.noContent()`, `ctx.json()`).

## Requirements

- Deno 2.9+
- TypeBox 1.x schemas
- Oxlint for linting

The repository is a Deno workspace with three members:

```text
packages/core   reusable framework primitives (@hyapi/core)
packages/cli    project/module generator, inspect, and doctor (@hyapi/cli)
apps/example    health, JWT-protected users, and orders API composed through a Port
```

## CLI

```text
deno run -A jsr:@hyapi/cli new my-api              create a starter project
deno run -A jsr:@hyapi/cli generate module billing create src/modules/billing
deno run -A jsr:@hyapi/cli inspect my-api          list modules, ports, and boundaries
deno run -A jsr:@hyapi/cli doctor my-api           diagnose boundary and structure problems
```

`generate module` prints the import line and the `createApplication({ modules })` entry to add to
`src/app.ts`. Shared ports belong in `src/contracts/`.

## Quick start

Set a local JWT secret with at least 32 bytes:

```powershell
$env:JWT_SECRET = "local-secret-with-at-least-32-characters"
deno task dev
```

The server listens on `http://127.0.0.1:8000` by default. `HOST`, `PORT`, `DENO_ENV`, `JWT_ISSUER`,
and `JWT_AUDIENCE` can be supplied as environment variables.

Deno permissions are deliberately explicit:

- `--allow-net` is needed by the HTTP listener.
- `--allow-env` is needed for configuration and JWT secrets.

See the [operations guide](docs/operations.md) for deployment, observability, and shutdown.

## Framework API

### 1. Defining Routes

Routes use `{name}` path parameters. The same route metadata is used for runtime JIT validation and
OpenAPI 3.1 generation. `GET` routes cannot declare a request body.

```ts
import { createApplication, defineConfig, defineModule, defineRoute } from "@hyapi/core";
import Type from "typebox";

const config = defineConfig({ name: "items-api" });

const itemsModule = defineModule({
  name: "items",
  setup(module) {
    module.route(defineRoute({
      method: "get",
      path: "/items/{id}",
      request: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        query: Type.Object({ limit: Type.Optional(Type.Integer({ default: 10 })) }),
      },
      responses: {
        200: Type.Object({ id: Type.String(), limit: Type.Integer() }),
        404: Type.Object({ message: Type.String() }),
      },
      handler: ({ params, query, ok }) => ok({ id: params.id, limit: query.limit ?? 10 }),
    }));
  },
});

const app = await createApplication({ config, modules: [itemsModule] });
```

### 2. Route Groups & Scoped Lifecycle Hooks

Route groups support nested prefixes, tags, auth scope inheritance, and group-scoped hooks:

```ts
export const usersModule = defineModule({
  name: "users",
  setup(module) {
    module.group("/v1/users", { tags: ["users"] }, (users) => {
      // Scoped hook only runs for routes within this group
      users.addHook("onRequest", ({ requestId, request }) => {
        console.log(`[users] ${request.method} ${request.url} (${requestId})`);
      });

      // Read routes inherit 'users:read' scope
      users.group({ auth: { scopes: ["users:read"] } }, (readers) => {
        readers.route(listUsersRoute);
        readers.route(getUserRoute);
      });

      // Write routes inherit 'users:write' scope
      users.group({ auth: { scopes: ["users:write"] } }, (writers) => {
        writers.route(createUserRoute);
        writers.route(updateUserRoute);
        writers.route(deleteUserRoute);
      });
    });
  },
});
```

Auth requirements are merged as a **union**: a route requires every scope declared by its enclosing
groups plus its own. In the example above, adding `auth: { scopes: ["users:admin"] }` to
`deleteUserRoute` would require both `users:write` and `users:admin`. Inherited authentication
cannot be downgraded: inside an authenticated group, `auth: false` or `auth: { required: false }` on
a route or nested group throws `ConfigurationError` at registration. Authentication stays optional
only when every level marks it `required: false`.

Hooks and routes can be registered only while the application is being configured; calling
`addHook`, `route`, or `setAuthProvider` after startup throws `ConfigurationError`.

### 3. Request Context & Semantic Helpers

The handler receives a typed request context:

- `params`, `query`, and `body` are inferred from TypeBox schemas, automatically type-coerced, and
  populated with schema defaults for request validation.
- Request bodies are parsed and validated only when `request.body` is declared. The body is required
  by default; set `request.bodyRequired: false` for an optional body. JSON media types include
  `application/*+json` (for example `application/merge-patch+json`).
- `identity` contains the verified JWT identity or `null`.
- `state` is request-local plugin state.
- `services.get(reference)` resolves an async singleton, request, or transient module service.
- `requestId` is the validated request ID and `requestIdHeader` is the header that carries it.
- `deadline` is always set: the absolute epoch-millisecond deadline of the request, the earlier of
  the upstream `x-hyapi-deadline` header and the request start plus `requestTimeoutMs`.
- `signal` is an `AbortSignal` that is aborted when the request times out; pass it to long-running
  work. JavaScript cannot stop a handler, so handlers should observe it.
- `ok(value, init)` creates a 200 JSON response.
- `created(value, init)` creates a 201 JSON response.
- `noContent(init)` creates a 204 response.
- `json(value, status, init)` creates a JSON response with custom status code.
- `respond(value, init)` supports custom response objects and headers.

Response schemas use `responses: { status: schema }`; the former single-schema `response` property
is no longer supported. Response bodies are cleaned against the declared schema, so undeclared
fields are never sent. A handler that returns a raw `Response` with an undeclared status fails with
500 `RESPONSE_CONTRACT_ERROR`.

### 4. Configuration

`defineConfig()` fills in defaults for the application configuration:

```ts
const config = defineConfig({
  name: "items-api",
  bodyLimitBytes: 1_048_576, // default 10485760 (10 MiB); larger bodies return 413
  requestTimeoutMs: 30_000, // default 300000 (5 minutes); expiry returns 503
  shutdownTimeoutMs: 10_000, // default 30000; how long close() waits for in-flight requests
  openapi: { enabled: false }, // default true; disables GET /openapi.json
});
```

- `bodyLimitBytes` limits every request body, including streamed bodies without `Content-Length`.
  Larger bodies are rejected with 413 `PAYLOAD_TOO_LARGE`.
- `requestTimeoutMs` bounds the time from global `onRequest` hooks to the handler's response. On
  expiry, `ctx.signal` is aborted and the client receives 503 `REQUEST_TIMEOUT`. A request whose
  upstream `x-hyapi-deadline` has already passed is rejected with 504 `DEADLINE_EXCEEDED` before the
  handler runs.
- `shutdownTimeoutMs` bounds how long `app.close()` waits for in-flight requests before aborting
  their `ctx.signal`.
- `openapi.enabled: false` removes the OpenAPI document route.

### 5. Modules, Services, and Plugins

Modules own business routes and services. Plugins provide cross-cutting platform capabilities such
as authentication, logging, and observability. Plugin `setup`, `onStart`, and `onClose` receive a
`PlatformApi` with exactly `addHook(point, hook)` and `setAuthProvider(provider)`; plugins cannot
register routes or reach the underlying HTTP runtime.

```ts
const databasePlugin = definePlugin({
  name: "database",
  setup(platform) {
    platform.addHook("onResponse", ({ requestId, response }) => {
      console.log({ requestId, status: response?.status });
    });
  },
});

const usersModule = defineModule({
  name: "users",
  setup(module) {
    const repository = module.singleton(() => new UserRepository());
    const service = module.request(async (services) =>
      new UserService(await services.get(repository))
    );
    module.route(defineRoute({
      method: "get",
      path: "/v1/users",
      handler: async ({ services, ok }) => ok(await (await services.get(service)).list()),
    }));
  },
});

const app = await createApplication({
  config,
  modules: [usersModule],
  plugins: [databasePlugin, jwtPlugin({ secret: env.JWT_SECRET })],
});

// Graceful shutdown stops accepting requests, waits for in-flight ones, then runs module and
// plugin onClose hooks in reverse order.
await app.close();
```

A singleton factory cannot resolve request-scoped services. A factory that throws is not cached, so
the next resolution retries it. Resolving a request-scoped service after its request ended, or a
singleton after `close()`, rejects with `AppError` code `SCOPE_CLOSED`. If startup fails, modules
and plugins that were already set up are closed in reverse order before `createApplication()`
rejects.

Lifecycle order is
`global onRequest → deadline/timeout check → group onRequest (outer→inner) → authentication → validation → handler → response validation → group onResponse (inner→outer) → global onResponse`.
Error responses also pass through group and global `onResponse` hooks (after `onError`); when an
`onResponse` hook throws, its error response replaces the response and the remaining outer hooks
still run. Everything from global `onRequest` to the handler's response is bounded by the earlier of
`requestTimeoutMs` and the upstream deadline; on expiry `ctx.signal` is aborted. `ctx.signal` is
also aborted when the client disconnects. Request-scoped services close after the response hooks,
and cleanup failures are reported to `onError` without changing the response. Failures use
`application/problem+json` (RFC 7807) and include the request ID.

### 6. Public Module Ports

Use a named Port for a capability that crosses a module boundary. Keep the port in a neutral
`contracts/` directory: a consuming module should never import another module's implementation.

```ts
// src/contracts/users.ts
import { definePort } from "@hyapi/core";

export interface UserDirectory {
  find(id: string): Promise<{ id: string } | null>;
}
export const userDirectory = definePort<UserDirectory>("users.directory");

// src/modules/orders/orders.module.ts
export const ordersModule = defineModule({
  name: "orders",
  requires: [userDirectory],
  setup(module) {
    const users = module.use(userDirectory);
    // use `users` in order use cases
  },
});

const app = await createApplication({
  config,
  modules: [usersModule, ordersModule],
  providers: [providePort(userDirectory, localUserDirectory)],
});
```

`createApplication()` rejects a missing port or an incompatible port version before accepting a
request. `module.use(port)` throws `ConfigurationError` unless the module lists the port in
`requires`. Port and contract versions are `{ major, minor }` objects; `definePort` defaults to
`{ major: 1, minor: 0 }`. Verify local, fake, and later remote providers against the same small
behavioral suite:

```ts
import { definePortContract, verifyPortContract, verifyPortContracts } from "@hyapi/core";

const userDirectoryContract = definePortContract<UserDirectory>(
  "users.directory",
  async (provider) => assertEquals(await provider.find("ada"), { id: "ada" }),
);

await verifyPortContract(userDirectoryContract, localUserDirectory);
await verifyPortContract(userDirectoryContract, fakeUserDirectory);
await verifyPortContracts(userDirectoryContract, [localUserDirectory, fakeUserDirectory]);
```

### 7. Optional HTTP Boundaries

When a module needs an independent deployment, keep its Port and replace only its local provider
with `provideHttp()`. A shared `defineHttpContract()` gives the service route registration and its
client the same TypeBox schemas and response statuses. Every remote client must set a timeout.
Retries are configured with `resilience.retry` and apply only to idempotent requests (`GET`, `PUT`,
`DELETE`, `OPTIONS`, or any request with an `idempotency-key` header); a custom `retryOn` cannot
bypass that rule. Pass `withHttpContext(ctx, "my-service")` headers to propagate the request ID,
`traceparent`, and `ctx.deadline`.

See [the v0.5 extraction guide](docs/migrations/v0.5.0.md) for the Users → Orders migration,
including contract validation, idempotency, and request-context propagation.

Provider lifecycle and major/minor contract compatibility are described in the
[v0.8 migration guide](docs/migrations/v0.8.0.md). Applications can inspect provider readiness with
`await app.health()`, which checks providers in parallel with a 5-second timeout each.

Remote-call resilience policies, including retry, circuit breaker, and bulkhead controls, are
described in the [v0.9 migration guide](docs/migrations/v0.9.0.md).

`v1.0.0-rc.2` removes superseded APIs and changes several defaults; see the
[v1.0.0 migration guide](docs/migrations/v1.0.0.md).

## Example API

Health endpoints are public:

```text
GET /health/live    liveness; always 200 while the process serves requests
GET /health/ready   readiness; 503 with provider reports when app.health() is unhealthy
```

User endpoints require a JWT with the listed scope:

```text
GET    /v1/users       users:read
GET    /v1/users/{id}  users:read
POST   /v1/users       users:write
PATCH  /v1/users/{id}  users:write
DELETE /v1/users/{id}  users:write
POST   /v1/orders      orders:write
```

OpenAPI 3.1 documentation is available at `GET /openapi.json`.

The framework verifies HS256 JWTs with Web Crypto. It requires a secret of at least 32 bytes and
validates `sub`, `exp`, `nbf`, optional `iss`/`aud`, clock skew tolerances, and scopes from either a
space-separated `scope` claim or a string-array `scopes` claim. Tokens with a `crit` header are
rejected. See [SECURITY.md](SECURITY.md) for the full security baseline.

## Development commands

```text
deno task dev             run the example with file watching
deno task start           run the example
deno task test            run all unit and integration tests (--allow-env --allow-read --allow-write)
deno task check           type-check core, CLI, example, benchmark, and script entry points
deno task fmt             format codebase
deno task fmt:check       verify formatting
deno task lint            run Oxlint
deno task doctor:example  run the CLI doctor against apps/example
deno task verify:starter  generate a starter project and check, test, and doctor it
deno task bench           run the core performance benchmarks
deno task publish:check   run the JSR publish dry-run for core and CLI
deno task verify          run the complete quality gate
```

The test suite uses in-memory `app.request()` and does not open a TCP port. `deno task verify` runs
formatting, lint, type checking, the test suite, `doctor:example`, and `verify:starter`.

## Project development

See the [roadmap](docs/roadmap.md) for planned milestones and [contribution guide](CONTRIBUTING.md)
for the development, verification, and release workflow.

Migrating from v0.1? Read the [v0.2 migration guide](docs/migrations/v0.2.0.md). For the
development-experience changes, see the [v0.7 migration guide](docs/migrations/v0.7.0.md).
