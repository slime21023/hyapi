# Dependency injection and lifecycle

HyAPI composes HTTP routes over an **application-owned InferDI root**. Pass the container as `createApp({ container, modules })`; each route receives that same typed container as `context.root`. The application registers its own resources and services. HyAPI neither registers business dependencies nor disposes the root for you. See [Modules and routes](./modules.md) for composing the application.

The ERP application's container registers shared values and a scoped order action. This is application code, not a required registration layout:

<<< ../../apps/example/src/container.ts

Here, `declareScopeInputs<{ identity: Identity }>()` lets the scoped `orders` factory read the authenticated identity. A protected module's `authenticate(request, root)` supplies that identity; HyAPI passes it as the scope input when a protected route accesses its scope. The [order action](https://github.com/slime21023/hyapi/blob/main/apps/example/src/modules/orders/purchase.ts) uses the resulting subject. Public scopes have no authenticated identity input. Read [Authentication and authorization](./auth.md) for the authentication and authorization order.

## Request scopes

Declare `scoped: true` on a route before using `context.scope`. The scope is created **lazily**, on first access, whether in `authorize` or `handler`; a route that never accesses it creates no scope. On the route's exit HyAPI awaits disposal of any created scope, including when authorization or the handler throws. Authentication and input-validation failures occur before the route's scope is available. `context.root` remains the shared application root, not a request scope.

Scope lifetime covers the authorization/handler path, **not independent consumption of a returned response stream**. Do not keep a scoped service alive by returning a stream: own its resources through stream completion and cancellation instead. The [ERP stream](https://github.com/slime21023/hyapi/blob/main/apps/example/src/stream.ts) owns and clears its timer on completion or cancellation.

## Serving and shutdown

`app.fetch(new Request(url, init))` handles in-process HTTP requests without binding a port. `await app.listen({ hostname, port })` starts an HTTP listener and returns a `Listener` with `url` and asynchronous `stop()`. The public listener test calls `stop()` twice; stopping is idempotent. Supply `listen({ fetch })` only if the application needs its own outer request wrapper, as in the [ERP entry point](https://github.com/slime21023/hyapi/blob/main/apps/example/src/main.ts). TLS, CORS, compression, global rate limits, logging, and other edge policy belong to the edge or such application-owned outer handling, not to a HyAPI plugin subsystem.

`await app.close()` stops admitting requests (**503** `APPLICATION_UNAVAILABLE` for new `app.fetch` work), stops its listeners, and waits for accepted handler work to finish. Calling `listen` after closing fails. Closing is safe to call again, but it does **not** dispose the root container or guarantee that a stream returned earlier has finished being consumed. There is no public shutdown deadline, request-cancellation orchestration, or signal-handler setup. The application must arrange signal handling and dispose its root and other resources after closing: [ERP composition](https://github.com/slime21023/hyapi/blob/main/apps/example/src/app.ts) closes HyAPI, then disposes the container and closes PostgreSQL; its [entry point](https://github.com/slime21023/hyapi/blob/main/apps/example/src/main.ts) owns the process signals. See [Testing applications](./testing.md) for in-process and real-listener checks.
