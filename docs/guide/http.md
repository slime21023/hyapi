# HTTP inputs, responses, and errors

A route declares its HTTP contract beside its handler. HyAPI accepts Standard Schema v1 validators; the [ERP example](../examples/erp.md) uses Valibot. The validated outputs become the types of `context.params`, `context.query`, and `context.body`. Without a `params` or `query` schema, the corresponding context value has type `Record<string, string>`.

## Declare inputs and output

Use `params`, `query`, `body`, and **singular** `response`. A response can be one schema for the ordinary result or a map from HTTP status numbers to schemas. `summary`, `description`, `tags`, and a unique `operationId` provide optional operation metadata. This application's user routes demonstrate validated body/path inputs, direct handler returns, and explicit not-found/forbidden errors:

<<< ../../apps/example/src/modules/users/routes.ts

Request parsing and validation finish before the route's `authorize` and `handler` callbacks. Invalid authenticated input produces HTTP 400, not a partially validated value in the handler. For a protected module, [authentication runs before body parsing](./auth.md).

## Select a success status

A plain value is the ordinary 200 result. To return another 2xx or 3xx status, declare the status in `response` and return `reply(status, value)` from the handler. This **addition to the Quickstart application** reuses its `AppContainer`, `responseSchema`, `container`, and `helloRoute`:

```ts
import {reply, type ModuleBuilder, type RouteApi} from 'hyapi';

function createMessageRoute(route: RouteApi<AppContainer, undefined>) {
  return route.post('/messages', {
    response: {201: responseSchema},
    handler: ({root}) => reply(201, {message: root.get('message')}),
  });
}

function helloModule(module: ModuleBuilder<AppContainer>) {
  return module({
    name: 'hello',
    prefix: '/hello',
    routes: route => [helloRoute(route), createMessageRoute(route)],
  });
}
```

After composing the same application, `POST /hello/messages` returns 201 and `{"message":"Hello from HyAPI"}`. `reply` rejects statuses outside integer 200–399; non-default success statuses must be declared in the route's response map. When a route declares `response`, replying with a status it does not declare (possible only through a cast or plain JavaScript) fails with a private 500 instead of sending an unvalidated body; a single response schema permits only 200. To add headers without giving up that validation, pass them as a third argument: ``reply(201, order, { headers: { location: `/orders/${order.id}` } })``. Several `Set-Cookie` values are kept as separate header lines, and none of the reply's headers are sent if the response then fails validation. For fully application-owned output, a handler may return a Web `Response`; do not assume its body is validated by the declared schema.

## Return deliberate failures

Throw `HttpError(status, message, code?)` for an intentional 400–599 error; its default code is `HTTP_ERROR`. `UnauthorizedError(message?)` and `ForbiddenError(message?)` specialize 401 and 403. Errors are not returned via `reply(4xx, ...)`. A handled error is sent as `application/problem+json` with `type`, `title`, `status`, `detail`, and `code`:

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "User not found.",
  "code": "USER_NOT_FOUND"
}
```

The user route above throws that specific 404 when the requested user is absent. HyAPI uses `PARSE_ERROR` or `VALIDATION_ERROR` for malformed or invalid requests (400). A `VALIDATION_ERROR` also lists each failed rule in `errors`, naming its location and an RFC 6901 JSON Pointer into it; the messages come from your schema and may echo values the client sent:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Request validation failed.",
  "code": "VALIDATION_ERROR",
  "errors": [
    {
      "in": "body",
      "pointer": "/user/qty",
      "message": "Invalid value: Expected >=1 but received 0"
    }
  ]
}
```

`errors` is omitted for parse failures, response-validation failures, and asynchronous schemas. Beyond those, HyAPI uses `NOT_FOUND` for unmatched routes (404), `UNROUTABLE_REQUEST` (400) when the request's host is too short for the internal router to locate the same path that authentication checks (for example `Host: api` behind a proxy; send a full host name instead), and `APPLICATION_UNAVAILABLE` for requests after closing starts (503). Unexpected failures and response-validation failures become a 500 `INTERNAL_SERVER_ERROR` with a generic detail; internal exception messages are not exposed to HTTP clients. To see them, pass `createApp({ ..., onError(error, request) { logger.error({ error, url: request.url }) } })`: HyAPI calls it for each private 500 without awaiting it, so a slow or failing logger cannot delay or alter the response. Application-owned `HttpError` messages and codes are deliberate public information.

Next: [authenticate and authorize](./auth.md), or inspect [public route and error types](../reference/core.md).
