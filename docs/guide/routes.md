# Routes and Authorization

Modules have a name, an absolute path prefix, and a `routes: (route) => [...]` callback. The route builder offers `get`, `post`, `put`, `patch`, and `delete`. Use `:id` for path parameters and Standard Schema for `params`, `query`, `body`, and `response`; Valibot works directly. A context exposes validated `params`, `query`, and `body`, the raw `request`, the `root` container, and (for protected modules) `identity`.

```ts
import { Container } from "@inferdi/inferdi";
import { createApp, ForbiddenError, UnauthorizedError, reply } from "hyapi";
import * as v from "valibot";

const container = new Container();
const app = createApp({
  container,
  modules: ({ module }) => [
    module({
      name: "items",
      prefix: "/items",
      authenticate(request) {
        const subject = request.headers.get("x-subject");
        if (!subject) throw new UnauthorizedError();
        return { subject };
      },
      routes: (route) => [
        route.get("/:id", {
          params: v.object({ id: v.string() }),
          response: { 200: v.object({ id: v.string(), owner: v.string() }) },
          authorize({ params, identity }) {
            if (params.id !== identity.subject) throw new ForbiddenError();
          },
          handler: ({ params, identity }) => reply(200, { id: params.id, owner: identity.subject }),
        }),
      ],
    }),
  ],
});
```

`authenticate(request, root)` runs at the module boundary before request validation. It returns a typed identity or rejects (for example with `UnauthorizedError`); a nullish result is unauthorized. An individual route's `authorize(context)` runs **after** validation and before `handler(context)`, for resource-specific permissions. Public modules omit `authenticate` and expose `identity` as `undefined`. Overlapping route patterns with different authentication policies are rejected at composition; `HEAD` requests routed to a protected `GET` inherit its authentication.

A single response schema accepts a plain validated return value (default success status). A status-keyed response map may also return plain data for a declared 200; use `reply(status, value)` to select non-default 2xx/3xx statuses. Return a native `Response` for an explicit HTTP response or a streaming body, and let the stream own any resources it needs until completion or cancellation. `HttpError`, `UnauthorizedError`, and `ForbiddenError` produce Problem JSON. See [composition](/guide/composition) for opt-in request scopes.
