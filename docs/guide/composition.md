# Composition

Create an InferDI root container yourself and pass it to `createApp`. Modules group routes; they do not own provider registration. A route accesses root dependencies through `root.get(...)`.

```ts
import { Container } from "@inferdi/inferdi";
import { createApp } from "hyapi";
import * as v from "valibot";

const container = new Container().registerValue("users", {
  find: (id: string) => ({ id, name: "Ada" }),
});
const app = createApp({
  container,
  modules: ({ module }) => [
    module({
      name: "users",
      prefix: "/users",
      routes: (route) => [
        route.get("/:id", {
          params: v.object({ id: v.string() }),
          response: v.object({ id: v.string(), name: v.string() }),
          handler: ({ params, root }) => root.get("users").find(params.id),
        }),
      ],
    }),
  ],
});
```

For request-specific dependencies, register a scoped InferDI factory and explicitly opt a route into scopes. A scope is created **lazily** when `scope` is read; it is disposed after the route handler finishes, including when authorization or handling throws. A protected module's authenticated identity is passed as a scope input:

```ts
import { Container } from "@inferdi/inferdi";
import { createApp, UnauthorizedError } from "hyapi";
import * as v from "valibot";

const root = new Container()
  .declareScopeInputs<{ identity: { subject: string } }>()
  .registerFactory("subject", (scope) => scope.get("identity").subject, ["identity"], "scoped");

const scopedApp = createApp({
  container: root,
  modules: ({ module }) => [
    module({
      name: "me",
      prefix: "/me",
      authenticate: (request) => {
        const subject = request.headers.get("x-subject");
        if (!subject) throw new UnauthorizedError();
        return { subject };
      },
      routes: (route) => [
        route.get("/", {
          scoped: true,
          response: v.object({ subject: v.string() }),
          handler: ({ scope }) => ({ subject: scope.get("subject") }),
        }),
      ],
    }),
  ],
});
```

Only `scoped: true` routes may access `scope`; ordinary routes can still use `root`. `app.close()` stops admission and drains accepted handlers but **does not dispose the caller's root**. Once closed, call `await root.dispose()` and explicitly close resources supplied through `registerValue` (such as a database pool). If application construction fails, dispose those resources as well. The [ERP example](https://github.com/slime21023/hyapi/blob/main/apps/example/src/app.ts) demonstrates both registration types and teardown.
