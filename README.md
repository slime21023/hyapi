# HyAPI

HyAPI `hyapi` v0.5.0 composes typed HTTP modules over an application-owned InferDI container. Declare routes with HyAPI's callback API and Standard Schema (Valibot in the example); Elysia is an internal router, not a consumer-facing API. Bun 1.4 manages development; built ESM runs on Node 24 or Bun. Local builds and tarballs do not establish npm publication.

## Try the ERP example

The private [Users, Orders, and Inventory example](apps/example/src/app.ts) uses PostgreSQL, HS256 Bearer authentication, owner/admin authorization, and transactional stock deduction. Start PostgreSQL 16 and supply `DATABASE_URL` and a random `JWT_SECRET` of at least 32 UTF-8 bytes:

```sh
docker run -d --name hyapi-postgres -e POSTGRES_PASSWORD=local -e POSTGRES_DB=hyapi -p 15432:5432 postgres:16
bun install --frozen-lockfile
DATABASE_URL=postgresql://postgres:local@127.0.0.1:15432/hyapi JWT_SECRET="<your-random-secret>" bun run dev
```

The listener defaults to `127.0.0.1:8000`; `HOST` and `PORT` are optional. No implicit `.env` loading: pass values in the process environment, or select a file with `bun --env-file=.env run dev`. On Windows, set both variables in your shell first. After `bun run build`, use `bun run start` (Bun) or `node apps/example/dist/main.js` (Node 24).

`GET /health/live` does not query the database; `GET /health/ready` does. The explicitly configured `GET /openapi/json` documents public and protected routes. Structured request logs come from an optional application-owned listener wrapper. See [operations](docs/guide/operations.md).

## Public API

Import `createApp`, `reply`, and HTTP errors from `hyapi`. Pass `createApp({ container, modules: ({ module }) => [...] })`; each module has a `routes: (route) => [...]` callback. Protected modules authenticate raw requests before validation, and individual routes authorize validated data. Request scopes are opt-in with `scoped: true`; the caller disposes its InferDI root and resources after `app.close()`. Core does not include PostgreSQL, a CLI, or independently published plugins. See the [guide](docs/index.md) and [migration instructions](docs/guide/migration-to-0.5.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification and Core-only packaging commands. A local tarball check does not establish npm publication.

## License

[MIT](LICENSE)
