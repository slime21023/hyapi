# HyAPI

HyAPI is a structured, type-safe API framework for Deno. It synthesizes the best design ideas from
Hapi (deterministic lifecycle hooks, explicit route contracts, fail-fast configuration, plugin
isolation) and Egg.js (layered engineering structure, hierarchical route grouping), built entirely
on top of Web Standards, Hono, and TypeBox.

## Key Features

- **Schema-Driven Contracts**: TypeBox schemas derive both static TypeScript types and native JIT
  validation with zero external validator dependencies.
- **Hierarchical Route Groups (`app.group`)**: Nested path prefixes, OpenAPI tags, auth scope
  inheritance, and group-scoped lifecycle hooks.
- **Multi-Format Request Body Parsing**: Automatic Content-Type parsing for `application/json`,
  `application/x-www-form-urlencoded`, and `multipart/form-data`.
- **OpenAPI 3.1 & RFC 7807 Out of the Box**: Native multi-status response schemas, accurate
  `bearerAuth` scope mapping, optional authentication support, and standardized Problem Details.
- **Plugin Dependency Graph (DAG) & Graceful Shutdown**: Plugins can be registered in any order and
  are automatically topologically sorted, supporting `register`, `onStart`, and `onClose` lifecycle
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
import { defineRoute } from "@hyapi/core";
import Type from "typebox";

const getUserRoute = defineRoute({
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
});

app.route(getUserRoute);
```

### 2. Route Groups & Scoped Lifecycle Hooks

Route groups support nested prefixes, tags, auth scope inheritance, and group-scoped hooks:

```ts
app.group("/v1/users", { tags: ["users"] }, (users) => {
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
```

### 3. Request Context & Semantic Helpers

The handler receives a typed request context:

- `params`, `query`, and `body` are inferred from TypeBox schemas, automatically type-coerced, and
  populated with schema defaults for request validation.
- Request bodies are parsed and validated only when `request.body` is declared. The body is required
  by default; set `request.bodyRequired: false` for an optional body.
- `identity` contains the verified JWT identity or `null`.
- `state` is request-local plugin state.
- `ok(value, init)` creates a 200 JSON response.
- `created(value, init)` creates a 201 JSON response.
- `noContent(init)` creates a 204 response.
- `json(value, status, init)` creates a JSON response with custom status code.
- `respond(value, init)` supports custom response objects and headers.

Response schemas use `responses: { status: schema }`; the former single-schema `response` property
is no longer supported.

### 4. Plugins & Lifecycle DAG

Plugins support dependency declarations with automatic topological sorting and full lifecycle
management:

```ts
const databasePlugin = {
  name: "database",
  async register(app) {
    app.decorate("db", new DatabaseClient());
  },
  async onStart(app) {
    const db = app.getDecoration<DatabaseClient>("db");
    await db?.connect();
  },
  async onClose(app) {
    const db = app.getDecoration<DatabaseClient>("db");
    await db?.disconnect();
  },
};

const servicePlugin = {
  name: "service",
  dependencies: ["database"], // Guaranteed to initialize after 'database'
  async register(app) {
    // Register routes and hooks
  },
};

// Registered in any order; HyAPI resolves dependencies automatically on app.ready()
await app.register(servicePlugin, {});
await app.register(databasePlugin, {});
await app.ready();

// Graceful shutdown reverses the topological order: service -> database
await app.close();
```

Lifecycle order is
`global onRequest → group onRequest → authentication → validation → handler → response validation → group onResponse → global onResponse`.
Failures use `application/problem+json` (RFC 7807) and include the request ID.

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
