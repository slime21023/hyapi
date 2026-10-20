# Integrations and Extensions

Core v0.5.0 accepts InferDI dependencies, HyAPI module declarations, and Standard Schema route schemas. It does not accept consumer-provided Elysia plugins or expose the old HyAPI `Plugin`, Ports, HTTP wrappers, or separately published integration packages. The old CLI and plugin packages are incompatible with this API and are not part of this workspace's publication set.

Register integrations in the caller-owned InferDI root; use `root.get(...)` in handlers or opt in to `scoped: true` for `scope.get(...)`. Implement authentication in a protected module's `authenticate(request, root)` callback and resource permission checks in each route's `authorize(context)`. The [example](https://github.com/slime21023/hyapi/blob/main/apps/example/src/app.ts) verifies HS256 Bearer tokens with `jose` directly rather than installing a JWT plugin.

Choose CORS, rate limiting, CSRF, TLS, and identity-provider integration deliberately at your host/proxy or application boundary; Core installs no implicit edge policy. The listener's optional `fetch` wrapper supports application-owned request logging. See [composition](/guide/composition) and [routes](/guide/routes).
