# OpenAPI

OpenAPI is optional. Without an `openapi` option, HyAPI does not expose a documentation endpoint. When enabled, it projects registered routes into an OpenAPI JSON document at `${path}/json`; it does not provide a Swagger or Scalar UI.

## Configure the JSON document

This **configuration fragment** comes from the ERP application's `createApp` options in [`buildExampleApp`](https://github.com/slime21023/hyapi/blob/main/apps/example/src/app.ts). It is not a standalone application:

```ts
openapi: {
  path: "/openapi",
  info: { title: "HyAPI ERP example", version: "0.5.0" },
  securitySchemes: { BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
},
```

The document is available at `/openapi/json` (for example, `http://127.0.0.1:8000/openapi/json` when running the [ERP example](../examples/erp.md)). `info.version` is the version of **your application's API metadata**, not an automatically assigned HyAPI release version. Set `path` and `info.title`/`info.version` yourself; `info.description` is optional.

HyAPI includes registered operations, request `params`, `query`, and `body` schemas, declared response schemas, and route `summary`, `description`, and `tags` when supplied. For a protected module, set `security` to the name of an entry in `openapi.securitySchemes`; the resulting operations reference that scheme, while public routes have no such requirement. The scheme only **documents** security: the module's `authenticate(request, root)` and route's `authorize(context)` implement it. See [Authentication and authorization](./auth.md).

## Schema conversion and composition failures

Valibot schemas have built-in JSON Schema conversion. For another Standard Schema vendor, supply a converter keyed by that schema's `~standard.vendor`. For example, the **option shape** is `converters: { [vendor]: (schema: Schema) => object }`, where `Schema` is exported from `hyapi`; the application must supply an actual converter suitable for its vendor. Converters are invoked when the application is composed, not deferred until the JSON URL is requested. A missing converter, a converter returning a non-object or array, or a conversion that throws prevents startup. Valibot conversion errors also prevent startup; no unsupported schema is silently omitted.

When OpenAPI is enabled, a protected module without `security` or with a scheme name absent from `securitySchemes` likewise fails composition. Without OpenAPI, no security-scheme declaration is needed for documentation, but authentication still belongs to the application. See [Modules and routes](./modules.md) for route registration and the [Core API reference](../reference/core.md) for `OpenApiOptions`.
