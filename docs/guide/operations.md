# Operating HyAPI

The private [ERP example](https://github.com/slime21023/hyapi/tree/main/apps/example) stores Users, Orders, and Inventory in PostgreSQL 16. Start a database (see [Getting Started](/guide/getting-started)), then inject a writable `DATABASE_URL` and a random `JWT_SECRET` of at least 32 UTF-8 bytes.

```sh
bun install --frozen-lockfile
bun run build
DATABASE_URL=postgresql://postgres:local@127.0.0.1:15432/hyapi JWT_SECRET="<your-random-secret>" bun run start
```

For Node 24 use `node apps/example/dist/main.js` with the same environment. `HOST` defaults to `127.0.0.1` and `PORT` to `8000`. No implicit `.env` loading: use `bun --env-file=.env run start` or `node --env-file=.env apps/example/dist/main.js` explicitly. Keep secrets outside source control and restrict access at your trusted network/proxy boundary.

## Reference workflow

The example creates its application-owned `hyapi_example_*` tables when it starts. Supply an HS256 Bearer token signed with `JWT_SECRET` containing `sub`; inventory writes also require `role: "admin"`. `POST /v1/users/` accepts `{ "name": "Ada" }`. An administrator sets stock with `POST /v1/inventory/` and `{ "sku": "ITEM-1", "quantity": 10 }`. An owner purchases with `POST /v1/orders/` and `{ "userId": "<uuid>", "sku": "ITEM-1", "quantity": 2 }`. `GET /v1/users/:id` and `/v1/orders/:id` enforce ownership. A conditional stock update and order insert share one SQL transaction; missing inventory returns 404 and insufficient stock returns 409 without an order or decrement. This example is single-tenant, not a packaged database integration.

## Listener and shutdown ownership

`await app.listen({ port, hostname?, fetch? })` serves directly on Bun or Node. It returns a listener with `url` and `stop()`. The example calls `listener.stop()` on shutdown and then `app.close()`, which stops any remaining listeners and drains accepted handlers. Core never disposes the caller's InferDI root; the example follows `app.close()` with `root.dispose()` and closes its database pool registered with `registerValue`. Do the same for resources you supply. Set host grace periods and traffic limits for uncooperative handlers yourself.

## Readiness, logs, and trace correlation

`GET /health/live` answers without PostgreSQL. `GET /health/ready` queries the pool (`SELECT 1`); connection failure returns 503 Problem JSON with code `DATABASE_UNAVAILABLE`. Route traffic to ready instances only. The optional application-owned wrapper passed as `listen({ fetch: tracedFetch })` logs request ID, trace ID, method, path, status, and time until response headers; it returns `x-request-id`. It accepts a syntactically valid W3C `traceparent` trace ID for correlation, otherwise generates one. Core does not install telemetry or a logger. Never log tokens, query secrets, or bodies.

## Streaming resources

`GET /health/stream` returns a native `Response` with three NDJSON events. Its `ReadableStream` releases its timer on completion or cancellation. A route's opt-in InferDI scope is disposed after its handler completes, **not** after a streamed body finishes transmitting. Open and close cursors, subscriptions, and file descriptors used by a stream in the stream itself.

## Deployment boundaries

Core does not install an ORM, SQL migration framework, CORS, TLS, WAF, compression, security headers, or global rate limiting. Coordinate schema changes and credentials through your deployment workflow. Keep edge policy at the host, proxy, or an explicitly application-owned wrapper. See [HTTP and OpenAPI](/guide/http-and-openapi) for the opt-in schema endpoint.
