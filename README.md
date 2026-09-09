# HyAPI

HyAPI is a structured, type-safe API framework for Deno. It synthesizes the best design ideas from
Hapi (deterministic lifecycle hooks, explicit route contracts, fail-fast configuration, plugin
isolation) and Egg.js (layered engineering structure, hierarchical route grouping), built entirely
on top of Web Standards, Hono, and TypeBox.

## Key Features

- **Schema-Driven Contracts**: TypeBox schemas derive both static TypeScript types and native JIT
  validation with zero external validator dependencies.
- **Hierarchical Route Groups (`module.group`)**: Nested path prefixes, OpenAPI tags, auth scope
  inheritance, and group-scoped lifecycle hooks.
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

The repository is a Deno workspace with two members:

```text
packages/core   reusable framework primitives
apps/example    health and JWT-protected users API
```

## Quick start

Set a local JWT secret with at least 32 characters:

```powershell
$env:JWT_SECRET = "local-secret-with-at-least-32-characters"
deno task dev
```

The server listens on `http://127.0.0.1:8000` by default. `HOST`, `PORT`, `DENO_ENV`, `JWT_ISSUER`,
and `JWT_AUDIENCE` can be supplied as environment variables.

Deno permissions are deliberately explicit:

- `--allow-net` is needed by the HTTP listener.
- `--allow-env` is needed for configuration and JWT secrets.

## Framework API

### 1. Defining Routes

Routes use `{name}` path parameters, which HyAPI translates to the underlying Hono `:name` syntax.
The same route metadata is used for runtime JIT validation and OpenAPI 3.1 generation.

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

### 3. Request Context & Semantic Helpers

The handler receives a typed request context:

- `params`, `query`, and `body` are inferred from TypeBox schemas, automatically type-coerced, and
  populated with schema defaults for request validation.
- Request bodies are parsed and validated only when `request.body` is declared. The body is required
  by default; set `request.bodyRequired: false` for an optional body.
- `identity` contains the verified JWT identity or `null`.
- `state` is request-local plugin state.
- `services.get(reference)` resolves an async singleton, request, or transient module service.
- `ok(value, init)` creates a 200 JSON response.
- `created(value, init)` creates a 201 JSON response.
- `noContent(init)` creates a 204 response.
- `json(value, status, init)` creates a JSON response with custom status code.
- `respond(value, init)` supports custom response objects and headers.

Response schemas use `responses: { status: schema }`; the former single-schema `response` property
is no longer supported.

### 4. Modules, Services, and Plugins

Modules own business routes and services. Plugins provide cross-cutting platform capabilities such
as authentication, logging, and observability. Both support dependency declarations and lifecycle
hooks, but plugins do not expose the underlying HTTP runtime.

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

// Graceful shutdown runs module and plugin lifecycle hooks in reverse order.
await app.close();
```

Lifecycle order is
`global onRequest → group onRequest → authentication → validation → handler → response validation → group onResponse → global onResponse`.
Failures use `application/problem+json` (RFC 7807) and include the request ID.

### 5. Public Module Ports

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
request. Verify local, fake, and later remote providers against the same small behavioral suite:

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

### 6. Optional HTTP Boundaries

When a module needs an independent deployment, keep its Port and replace only its local provider
with `provideHttp()`. A shared `defineHttpContract()` gives the service route registration and its
client the same TypeBox schemas and response statuses. Every remote client must set a timeout; safe
methods can retry transient network and server failures.

See [the v0.5 extraction guide](docs/migrations/v0.5.0.md) for the Users → Orders migration,
including contract validation, idempotency, and request-context propagation.

Provider lifecycle and major/minor contract compatibility are described in the
[v0.8 migration guide](docs/migrations/v0.8.0.md). Applications can inspect provider readiness with
`await app.health()`.

Remote-call resilience policies, including retry, circuit breaker, and bulkhead controls, are
described in the [v0.9 migration guide](docs/migrations/v0.9.0.md).

The v1.0.0 release candidate preserves the v0.9 API while hardening timeout budgets, FIFO
concurrency isolation, breaker classification, and release verification. See the
[v1.0.0 candidate guide](docs/migrations/v1.0.0.md).

## Example API

Health endpoints are public:

```text
GET /health/live
GET /health/ready
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

The framework verifies HS256 JWTs with Web Crypto. It validates `sub`, `exp`, optional `iss`/`aud`,
clock skew tolerances, and scopes from either a space-separated `scope` claim or a string-array
`scopes` claim.

## Development commands

```text
deno task dev          run the example with file watching
deno task start        run the example
deno task test         run all unit and integration tests
deno task check        type-check core and example entry points
deno task fmt          format codebase
deno task fmt:check    verify formatting
deno task lint         run Oxlint
deno task verify       run the complete quality gate
```

The test suite uses in-memory `app.request()` and does not open a TCP port.

## Project development

See the [roadmap](docs/roadmap.md) for planned milestones and [contribution guide](CONTRIBUTING.md)
for the development, verification, and release workflow.

Migrating from v0.1? Read the [v0.2 migration guide](docs/migrations/v0.2.0.md). For the
development-experience changes, see the [v0.7 migration guide](docs/migrations/v0.7.0.md).
