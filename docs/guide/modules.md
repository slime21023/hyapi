# Modules and routes

A module groups HTTP routes under one prefix. It is not a business-module boundary imposed by HyAPI: choose the boundaries and dependencies of your application, then pass the resulting route groups to `createApp`.

## Assemble small components

The [Quickstart](./quickstart.md) starts with a Valibot response schema, a typed `helloRoute`, and a typed `helloModule`, then composes them into an application:

```ts
const app = createApp({
  container,
  modules: ({ module }) => [helloModule(module)],
});
```

This is an excerpt from the Quickstart; it uses the `container` and `helloModule` defined there. `module` has the InferDI root's type, so `ModuleBuilder<AppContainer>` preserves the graph in its routes. `RouteApi<AppContainer, undefined>` supplies route methods in the public module. For protected modules, its second type parameter is the return type of `authenticate`.

The application-owned inventory example keeps its schemas, named route functions, authorization and module composition in a single readable sequence:

<<< ../../apps/example/src/modules/inventory/routes.ts

Its SQL store, bearer verification and roles are application code, not extra HyAPI APIs. The other modules are assembled by [`buildExampleApp`](https://github.com/slime21023/hyapi/blob/main/apps/example/src/app.ts); see the [ERP walkthrough](../examples/erp.md).

## Routes and paths

`routes: (route) => [setStockRoute(route), readStockRoute(route)]` runs during composition. `route.get`, `.post`, `.put`, `.patch`, and `.delete` accept an absolute route path and options with a `handler`. `prefix: "/v1/inventory"` plus `path: "/:sku"` registers `GET /v1/inventory/:sku`. A public module supplies `name`, `prefix`, and `routes`; a protected one additionally supplies `authenticate` and can declare OpenAPI `security`.

A module name must be nonempty and unique within an app. Prefixes must begin with `/`; only the root prefix `/` may end in `/`. Route paths must begin with `/`; duplicate method/path pairs fail composition. The pre-routing authentication matcher supports a whole-segment `:name` parameter or a literal path segment, not wildcard, optional, or regex path syntax. Overlapping routes with different authentication policies fail composition, including static-versus-parameter matches for the same method; split access by unambiguous paths rather than relying on registration order. Do not depend on case, percent-encoding, or HEAD matching behavior not defined in the public contract.

The module's `routes` callback constructs route declarations; the individual `handler` functions run only on requests. `createApp` does not register your services: provide an application-owned InferDI root and access it through `context.root`, or opt into a request [scope](./di-lifecycle.md).

Next: [validate inputs and responses](./http.md), or [protect a module](./auth.md). Check the [public API reference](../reference/core.md) for the full options and generic types.
