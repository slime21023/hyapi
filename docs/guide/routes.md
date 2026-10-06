# Routes and Responses

A route declares its request schemas, possible response schemas, and handler in one place. HyAPI
uses this metadata for runtime validation and OpenAPI generation.

```ts
import { createApplication, defineConfig, type Module } from "@hyapi/core";
import Type from "typebox";

const itemsModule: Module = {
  name: "items",
  setup(module) {
    module.route({
      method: "get",
      path: "/items/{id}",
      request: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        query: Type.Object({ limit: Type.Integer({ default: 10 }) }),
      },
      responses: {
        200: Type.Object({ id: Type.String(), limit: Type.Integer() }),
        404: Type.Object({ message: Type.String() }),
      },
      handler: ({ params, query, ok, json }) =>
        params.id === "missing"
          ? json({ message: "Item was not found." }, 404)
          : ok({ id: params.id, limit: query.limit }),
    });
  },
};

const app = await createApplication({
  config: defineConfig({ name: "items-api" }),
  modules: [itemsModule],
});
```

## Request rules

- Paths use `{name}` parameters. Required static `params` schema properties must match the full
  path.
- `GET` routes cannot declare a request body.
- HyAPI coerces request values and applies schema defaults before calling the handler. Declare a
  defaulted field without `Type.Optional`: the default fills a missing value before validation, so
  `query.limit` above is typed `number`. With `Type.Optional`, it would be `number | undefined`.
- Register a static path such as `/users/me` before `/users/{id}` so it cannot be shadowed.

## Guards

A guard authenticates or authorizes a route before HyAPI reads its body or validates its input. It
can return an `Identity`, return nothing, or throw an `AppError` such as `UnauthorizedError` (401)
or `ForbiddenError` (403).

```ts
import { anyOf, defineGuard, requireScopes, UnauthorizedError } from "@hyapi/core";

const ownsAccount = defineGuard({
  name: "ownsAccount",
  check({ identity, params }) {
    if (identity?.subject !== params.accountId) throw new UnauthorizedError();
  },
});

module.group("/accounts/{accountId}", { guards: [anyOf(bearer, apiKey)] }, (accounts) => {
  accounts.route({
    method: "get",
    path: "",
    guards: [requireScopes("accounts:read"), ownsAccount],
    handler: ({ identity, ok }) => ok({ subject: identity?.subject }),
  });
});
```

- Group guards run first, from the outermost group inwards, then route guards. A route or nested
  group can add guards but cannot remove inherited ones.
- Guards run before body parsing and validation, so an unauthenticated request receives 401 before
  any 400. Guards see raw `params` and `query` strings and must not read the body; checks that need
  the validated body belong in the handler.
- The first identity a guard returns becomes `ctx.identity`. A chain that returns two different
  identities is a configuration error; use `anyOf()` to accept one of several credentials.
- `requireScopes()` rejects a request without an identity with 401 and a request missing a scope
  with 403.
- A guard's `security` metadata becomes the route's OpenAPI security requirement. Guards without it
  only document 403.

### Sharing a guard across modules

Provide the application's authentication guard through a Port instead of passing it to every module
factory. Modules stay plain values and declare the dependency like any other Port.

```ts
// contracts/auth.ts
export const authPort = definePort<Guard>("platform.auth");

// modules/orders/module.ts
export const ordersModule: Module = {
  name: "orders",
  requires: [authPort],
  setup(module) {
    module.group("/orders", { guards: [module.use(authPort)] }, (orders) => {
      // routes
    });
  },
};

// app.ts
await createApplication({
  config,
  modules: [ordersModule],
  providers: [providePort(authPort, jwtBearer({ secret }))],
});
```

Tests substitute the guard by providing a different value for `authPort`.

## Response rules

Use `ok`, `created`, `noContent`, `json`, or `respond` to return framework-managed responses. HyAPI
validates the declared status and removes properties that the response schema does not declare.

When a route declares `responses`, the helpers and the handler's return type follow them at compile
time:

- `ok(body)`, `created(body)`, and `json(body, status)` accept only declared statuses, with a body
  of that status's schema. `noContent()` requires a declared 204.
- A bare return value must match one of the declared schemas.
- Routes without `responses` keep untyped helpers.

Without `responseStatus` or a helper status, a handler that returns nothing responds with 204, a
`POST` body with 201, and any other body with 200.

Use `defineRoute()` for a route defined in its own file; it keeps the literal method and the
inferred types:

```ts
export const getItem = defineRoute({
  method: "get",
  path: "/items/{id}",
  responses: { 200: Item },
  handler: ({ ok }) => ok({ id: "1", name: "Book" }),
});
```

A native `Response` remains an opaque-body escape hatch: HyAPI checks its declared status but does
not validate or filter its body. Use it only when the caller intentionally owns body serialization.
