# HyAPI

HyAPI is a structured TypeScript API framework for Deno. It borrows useful ideas from Hapi—plugins,
explicit routes, request context, lifecycle hooks, and fail-fast configuration—while using Hono and
Web APIs instead of `@hapi/hapi`.

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

Routes use `{name}` path parameters, which HyAPI translates to the underlying Hono `:name` syntax.
The same route metadata is used for runtime validation and OpenAPI generation.

```ts
import { defineRoute } from "@hyapi/core";
import Type from "typebox";

const route = defineRoute({
  method: "get",
  path: "/items/{id}",
  request: {
    params: Type.Object({ id: Type.String({ minLength: 1 }) }),
  },
  response: Type.Object({ id: Type.String() }),
  handler: ({ params }) => ({ id: params.id }),
});

app.route(route);
```

The handler receives a typed request context:

- `params`, `query`, and `body` are inferred from TypeBox schemas.
- `identity` contains the verified JWT identity or `null`.
- `state` is request-local plugin state.
- `respond(value, init)` supports status codes and headers.
- `noContent()` creates a 204 response.

Plugins register dependencies, routes, decorations, and lifecycle hooks:

```ts
const metricsPlugin = {
  name: "metrics",
  register(app) {
    app.addHook("onResponse", ({ requestId, response }) => {
      console.log({ requestId, status: response?.status });
    });
  },
};

await app.register(metricsPlugin, {});
```

Lifecycle order is `onRequest → authentication → validation → handler →
onResponse`. Failures use
`application/problem+json` and include the request ID.

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

The example uses an in-memory repository so it can run without database setup. Replace it through
the `UserRepository` interface when adding persistence.

OpenAPI 3.1 is available at `GET /openapi.json`.

The framework verifies HS256 JWTs with Web Crypto. It validates `sub`, `exp`, optional `iss`/`aud`,
and scopes from either a space-separated `scope` claim or a string-array `scopes` claim. Token
issuance is intentionally outside the framework.

## Development commands

```text
deno task dev          run the example with file watching
deno task start        run the example
deno task test         run all tests
deno task check        type-check core and example entry points
deno task fmt:check    verify formatting
deno task lint         run Oxlint
deno task verify       run the complete quality gate
```

The test suite uses `app.request()` and does not open a TCP port.
