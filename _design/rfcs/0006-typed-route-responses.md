# RFC 0006: Typed route responses

- Status: Proposed (implemented for review in v1.0.0-rc.5)
- Target: v1.0.0-rc.5

## Problem

A route that declares `responses` still accepts any handler result at compile time:

```ts
module.route({
  method: "get",
  path: "/items/{id}",
  responses: { 200: Item }, // { id: string; name: string }
  handler: ({ ok }) => ok({ id: 1 }), // compiles; fails only at runtime
});
```

`RouteHandler` returns `MaybePromise<unknown>`, and `ok<T>()` is not connected to the declared
schemas. HTTP contract handlers have the same gap. In addition, a route written apart from `route()`
loses its literal `method` and fails to type-check unless it is cast.

## Decision

### Helpers and results follow the declared responses

When a route declares `responses`, its context helpers and its return type are derived from them:

| Helper                | Accepted body                   | Status |
| --------------------- | ------------------------------- | ------ |
| `ok(body)`            | the 200 schema                  | 200    |
| `created(body)`       | the 201 schema                  | 201    |
| `noContent()`         | none                            | 204    |
| `json(body)`          | the 200 schema                  | 200    |
| `json(body, status)`  | the schema of a declared status | status |
| `respond(body, init)` | any declared schema             | init   |

A helper for an undeclared status does not compile: its parameter type is `never`, or its result is
not assignable to the handler's return type. A handler may return a helper result for a declared
status, a bare body that matches a declared schema, or a native `Response`, whose status is still
checked at runtime.

Routes without `responses` keep the generic helpers and an `unknown` return type.

The public types are `ResponseResult<T, S>` (with a phantom status), `DeclaredStatus<R>`,
`ResponseBody<R, S>`, `ResponseHelpers<R>`, `TypedResponseHelpers<R>`, `UntypedResponseHelpers`, and
`RouteResult<R>`. `RequestContext` and `RouteHandler` gain a trailing `TResponse` type parameter
that defaults to `undefined`, so existing references keep compiling. `RequestContext` becomes
`RequestInput & ResponseHelpers<TResponse>`.

HTTP contract handlers receive the same context and return type from the contract route's
`responses`.

Runtime status and schema checks are unchanged. They remain the safety net for casts and native
`Response` values.

### `defineRoute()`

`defineRoute(route)` returns its argument and exists only for inference:

```ts
export const getItem = defineRoute({
  method: "get",
  path: "/items/{id}",
  request: { params: Type.Object({ id: Type.String() }) },
  responses: { 200: Item, 404: Missing },
  handler: ({ params, ok, json }) =>
    params.id === "missing" ? json({ message: "Not found." }, 404) : ok(findItem(params.id)),
});

module.route(getItem);
```

## Compatibility and migration

Handlers whose results disagree with their declared responses stop compiling. Each such error points
at a real contract violation that previously surfaced as a runtime 500. Objects with extra
properties still compile when they are not fresh literals, and response validation still strips the
undeclared properties at runtime.

`HealthCheckReport.detail` is now typed `string` (omitted when absent) instead of
`string | undefined`, matching what the health registry emits.

## Alternatives

- **An opt-in strict helper set:** this leaves the default unsafe and doubles the helper surface.
- **Checking only `ok()`:** bare values and `json(body, status)` would remain unchecked, and they
  are the common source of mistakes.

## Acceptance criteria

- A wrong body for `ok`, an undeclared status for `json` or `noContent`, a wrong bare body, and a
  wrong contract handler body fail to compile.
- Routes without `responses` are unchanged.
- `defineRoute()` keeps the literal method and inference for routes defined in their own files.
