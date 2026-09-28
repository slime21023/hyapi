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
        query: Type.Object({ limit: Type.Optional(Type.Integer({ default: 10 })) }),
      },
      responses: {
        200: Type.Object({ id: Type.String(), limit: Type.Integer() }),
        404: Type.Object({ message: Type.String() }),
      },
      handler: ({ params, query, ok }) => ok({ id: params.id, limit: query.limit ?? 10 }),
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
- HyAPI coerces request values and applies schema defaults before calling the handler.
- Register a static path such as `/users/me` before `/users/{id}` so it cannot be shadowed.

## Response rules

Use `ok`, `created`, `noContent`, `json`, or `respond` to return framework-managed responses. HyAPI
validates the declared status and removes properties that the response schema does not declare.

A native `Response` remains an opaque-body escape hatch: HyAPI checks its declared status but does
not validate or filter its body. Use it only when the caller intentionally owns body serialization.
