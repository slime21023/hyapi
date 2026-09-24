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
[security policy](SECURITY.md), [operations guide](docs/operations.md),
[error-scope ADR](docs/adr/0001-layered-error-scopes.md), and
[performance baseline](docs/baselines/performance.md).

## Key Features

- **Schema-Driven Contracts**: TypeBox schemas infer request `params`, `query`, and `body` types;
  framework-serialized responses are schema-validated at runtime, not statically checked against
  response schemas. Native `Response` bodies remain opaque.
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
cd my-api
deno run -A jsr:@hyapi/cli generate module billing create src/modules/billing
deno run -A jsr:@hyapi/cli inspect .                list modules, ports, and boundaries
deno run -A jsr:@hyapi/cli doctor .                 diagnose boundary and structure problems
```

The JSR CLI command requires a published `@hyapi/cli` package. From a checkout, use
`deno run --allow-read --allow-write packages/cli/mod.ts new my-api`; then `cd my-api` before
running `deno run --allow-read --allow-write ../packages/cli/mod.ts generate module billing`. The
generated starter depends on `jsr:@hyapi/core@^1.0.0-rc.2` and cannot check or start independently
until that version is published. `deno task verify:starter` checks a local-source substitution, not
registry availability; after publishing, run
`deno run --allow-read --allow-write --allow-run --allow-env scripts/verify-starter.ts --published`
to check an unmodified starter.

`generate module` prints the import line and the `createApplication({ modules })` entry to add to
`src/app.ts`. Shared ports belong in `src/contracts/`.

Creating a module does not register it: add the printed import and `modules` array entry manually.
`doctor` checks project structure and Port boundaries heuristically; a healthy report does not prove
every module under `src/modules/` is included in `createApplication()`.

In a generated project, `deno task verify` checks formatting, types, and tests; generated module
tests exercise their GET routes even before manual registration. `deno task start` listens on
`127.0.0.1:8000` by default; set `HOST` and `PORT` to choose the listener address and port.
Generated `dev` and `start` tasks grant `--allow-net` and `--allow-env`.

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

For a statically inspectable TypeBox object `request.params` schema, each required property without
a default must appear as `{name}` in the **full registered path**, including any group prefix. A
mismatch rejects route setup with `ConfigurationError`; routes without a params schema and dynamic
schemas keep their existing behavior. Header schema property names match HTTP headers
case-insensitively (`X-Tenant-Id` accepts `x-tenant-id`), but duplicate casing aliases within the
same object schema reject configuration.

Route matching follows registration order. Register a static sibling such as `GET /users/me`
**before** `GET /users/{id}`: if the parameter route comes first, it can match `/users/me` with
`id = "me"`, shadowing the static route's auth, hooks, handler, and response status.

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
is no longer supported. Helper results such as `ok(...)`, `respond(...)`, and bare return values are
cleaned and validated against the declared response schema before serialization, removing undeclared
fields. Helper payloads are **not** statically checked against response schemas; a mismatch fails at
runtime with 500 `RESPONSE_VALIDATION_ERROR`.

A native `Response` is an opaque **body** escape hatch: with `responses` declared, HyAPI checks its
status and returns 500 `RESPONSE_CONTRACT_ERROR` for an undeclared status, but does not validate or
clean its body. **Security:** `Response.json({ id, passwordHash })` can send `passwordHash` even if
the response schema declares only `id`. Use `ok({ id, passwordHash })` when schema-based stripping
and validation are required. Native response streams retain the return-time ownership described
below.

For a declared 4xx/5xx response status, OpenAPI documents both `application/json` for JSON returned
by the handler and `application/problem+json` for a thrown `AppError` at that status. It does not
invent response bodies for success statuses or schemas for untyped fallback statuses.

### 4. Configuration

`defineConfig()` fills in defaults for the application configuration:

```ts
const config = defineConfig({
  name: "items-api",
  bodyLimitBytes: 1_048_576, // default 10485760 (10 MiB); larger bodies return 413
  requestTimeoutMs: 30_000, // default 300000 (5 minutes); expiry returns 503
  shutdownTimeoutMs: 10_000, // default 30000; request drain and separate resource cleanup budgets
  openapi: { enabled: false }, // default true; disables GET /openapi.json
});
```

- `bodyLimitBytes` limits every request body, including streamed bodies without `Content-Length`.
  Larger bodies are rejected with 413 `PAYLOAD_TOO_LARGE`.
- `requestTimeoutMs` bounds the time from global `onRequest` hooks to the handler's response. On
  expiry, `ctx.signal` is aborted and the client receives 503 `REQUEST_TIMEOUT`. A request whose
  upstream `x-hyapi-deadline` has already passed is rejected with 504 `DEADLINE_EXCEEDED` before the
  handler runs.
- `shutdownTimeoutMs` bounds how long `app.close()` drains in-flight requests before aborting their
  `ctx.signal`; it then waits at most `min(1000, shutdownTimeoutMs)` for cooperative cleanup and
  gives application resource closers a separate `shutdownTimeoutMs` budget. Uncooperative work can
  outlive provider closure; see the [operations guide](docs/operations.md#graceful-shutdown).
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

If provider connection fails, its rollback errors and later plugin/module cleanup errors form one
flat `AggregateError`: the original connect exception is first, followed by cleanup errors in order,
including errors from nested aggregates. The original cause chain is retained.

Lifecycle order is
`global onRequest → deadline/timeout check → group onRequest (outer→inner) → authentication → validation → handler → response contract (declared status; body validation for framework-serialized values) → group onResponse (inner→outer) → global onResponse`.
Matched-route failures notify group then global `onError` and pass through remaining response hooks.
Unmatched 404 is a routing result: it skips `onError` but reaches global `onResponse`. When an
`onResponse` hook throws, its error response replaces the response and the remaining outer hooks
still run; `onError` is observational and cannot swallow that failure. Unknown handler/hook errors
become hidden 500 `INTERNAL_ERROR` before return. A returned `Response` that cannot accept the
request ID instead becomes a fresh hidden 500 without rerunning response hooks. Everything from
global `onRequest` to the handler's response is bounded by the earlier of `requestTimeoutMs` and the
upstream deadline; on expiry `ctx.signal` is aborted. `ctx.signal` also aborts on a client
disconnect while the request scope is active, not after it ends. Request-scoped services close after
response hooks; cleanup failures notify `onError` without changing the selected response. Pre-return
HTTP failures use `application/problem+json` (RFC 7807) and include the request ID.

`onError` observers run group then global in order, each receiving the failure being reported even
if a prior observer changed `lifecycle.error`. They are awaited only within the original request
deadline or until forced shutdown; cleanup notifications use whatever time remains after the request
ends. Unsettled observer promises do not block the response indefinitely, but can still run and
mutate shared state later. Their completion is not guaranteed.

For routes with a body schema, HyAPI buffers at most `bodyLimitBytes` once before parsing and gives
the handler and lifecycle hooks independent requests. After that buffering, hooks can read the
original body with `await request.clone().text()` (or another clone reader), even when the handler
consumed its request. Hooks sharing the lifecycle request must clone it themselves; directly
consuming it prevents subsequent hooks from reading it. Before buffering completes—including 413,
early validation failures, and routes with streaming bodies but no body schema—hooks cannot assume
that a complete body can be replayed.

Native `Response` streams are returned without buffering. The request scope and request services
close when `app.request()`/`app.fetch()` returns, **not** when the body is read. A stream must own
any resource it needs until `pull`/`cancel` completes; it must not use request services, singletons,
providers, or `ctx.signal` after return. For example, this stream owns its data:

```ts
const streamRoute = defineRoute({
  method: "get",
  path: "/stream",
  handler: () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("ready\n"));
          controller.close();
        },
      }, { highWaterMark: 0 }),
    ),
});
```

Once the response is returned, body read/transport errors belong to the consumer or server; HyAPI
cannot replace an already committed response with problem+json or invoke `onError` again.

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
deno task verify:starter  generate a starter project and run its verify task and CLI doctor
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
