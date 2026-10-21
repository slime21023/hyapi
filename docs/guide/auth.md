# Authentication and authorization

A public module has no `authenticate` function; its routes receive `identity: undefined`. A protected module supplies `authenticate(request, root)`, and the returned value becomes the typed `identity` of its routes. The `root` is the application-owned InferDI container. HyAPI does not supply credentials, JWT verification, or an identity provider: the application decides how to authenticate and what identity means.

The ERP application's bearer-token implementation is one such policy, not a HyAPI-provided authentication service:

<<< ../../apps/example/src/auth.ts

The [inventory module](https://github.com/slime21023/hyapi/blob/main/apps/example/src/modules/inventory/routes.ts) passes this `authenticate` function to its module definition. Its `setStockRoute` uses `authorize({ identity })` to require the `admin` role before the handler changes stock. A protected module can contain routes with different authorization rules, but they share its authentication policy. See [Modules and routes](./modules.md) for composing named routes and modules.

## Order and failures

For a protected route, HyAPI calls `authenticate` **before** parsing or validating the request body. Return a non-nullish identity or throw `UnauthorizedError` for missing or invalid credentials; a `null` or `undefined` result also produces **401**. Request `params`, `query`, and `body` schemas validate before route `authorize` and `handler` run. Once inputs validate, `authorize(context)` runs before `handler(context)`; throw `ForbiddenError` for a **403** when an authenticated identity lacks permission. Do not return a denial from `authorize` and expect it to stop the handler.

The [public contract tests](https://github.com/slime21023/hyapi/blob/main/tests/core/public/v05_hyapi_test.ts) demonstrate the precedence on a protected POST route:

| Request                                                     | Outcome                      |
| ----------------------------------------------------------- | ---------------------------- |
| No credentials and malformed JSON                           | **401**, before JSON parsing |
| Valid credentials and malformed JSON or invalid input       | **400**, before `authorize`  |
| Valid credentials and valid input, but authorization denied | **403**, before `handler`    |

Errors use `application/problem+json`; see [HTTP inputs, responses, and errors](./http.md) for Problem responses. A route needing request-specific dependencies can also use a [lazy request scope](./di-lifecycle.md) inside `authorize`.

## Composition and OpenAPI

HyAPI rejects overlapping routes with different authentication policies during application composition, including a public route overlapping a protected parameterized route. Do not rely on route registration order to decide whether authentication applies.

When [OpenAPI](./openapi.md) is enabled, a protected module must supply `security` naming a configured `openapi.securitySchemes` entry; the resulting security metadata describes the route but does not authenticate requests. Without OpenAPI configuration, no security scheme or documentation endpoint is required. A public module cannot declare `security`.
