# Configuration

`createApp({ container, modules, openapi? })` accepts an InferDI root, module builder callback, and optional explicit OpenAPI settings. It has no `defineConfig()`, implicit environment loader, built-in timeout/body limit, or default edge policy. Inject application settings through your composition root. `app.listen({ port, hostname?, fetch? })` configures the listener; the optional `fetch` is an application-owned outer wrapper, for example for logging.

The [example entry point](https://github.com/slime21023/hyapi/blob/main/apps/example/src/main.ts) reads:

| Variable       | Required | Effect                                               |
| -------------- | -------- | ---------------------------------------------------- |
| `JWT_SECRET`   | Yes      | HS256 secret of at least 32 UTF-8 bytes              |
| `DATABASE_URL` | Yes      | PostgreSQL connection URI; database must be writable |
| `HOST`         | No       | Listener hostname; defaults to `127.0.0.1`           |
| `PORT`         | No       | TCP port; defaults to `8000`                         |

The example verifies JWT signatures with `jose`, requires a `sub` claim, and uses `role: "admin"` for inventory writes. It does not configure issuer or audience policy; supply your own checks if needed. Use a dedicated database/account and restrict network access. Never use the placeholder in `.env.example` as a production key.

Environment variables come from the invoking process. No implicit `.env` loading: explicitly opt in with `bun --env-file=.env run dev` or `node --env-file=.env apps/example/dist/main.js`. Do not commit secret-bearing files. For dependency registrations and ownership see [composition](/guide/composition); for listener settings see [operations](/guide/operations).
