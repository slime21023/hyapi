# HTTP and OpenAPI

`app.fetch(request: Request): Promise<Response>` handles requests without binding a listener. `app.listen({ port, hostname?, fetch? })` binds on Bun or Node and returns a listener with `url` and asynchronous `stop()`. HyAPI does not export the old `defineHttpContract()`, `createHttpClient()`, `provideHttp()`, or `withHttpContext()` APIs. Use native `Request`/`Response` for transport and native `Response` with `ReadableStream` for streaming; the stream itself must own resources needed after its handler returns.

## OpenAPI is explicit

Omit `openapi` to serve no documentation endpoint. To expose JSON at `/openapi/json`, provide `path: "/openapi"`, document info, and security scheme definitions for protected modules:

```ts
const app = createApp({
  container,
  modules: ({ module }) => [
    module({
      name: "health",
      prefix: "/health",
      routes: (route) => [
        route.get("/live", {
          response: v.object({ status: v.literal("ok") }),
          handler: () => ({ status: "ok" as const }),
        }),
      ],
    }),
  ],
  openapi: {
    path: "/openapi",
    info: { title: "Service API", version: "0.5.0" },
  },
});
```

Import `createApp` from `hyapi`, `v` from `valibot`, and supply an InferDI `container` as in [Getting Started](/guide/getting-started). Route schemas use Standard Schema. Valibot schemas are converted to JSON Schema by the built-in converter; if OpenAPI is enabled and a route uses another schema vendor, supply `openapi.converters[vendor] = (schema) => jsonSchemaObject` or application construction fails. Unsupported Valibot schema conversion also fails at construction. Protected modules require a `security` name matching a key in `openapi.securitySchemes` when OpenAPI is enabled; public routes remain public. The [ERP example](https://github.com/slime21023/hyapi/blob/main/apps/example/src/app.ts) configures `BearerAuth`. Core projects documented routes from the same module declarations that it serves, without a second route list.
