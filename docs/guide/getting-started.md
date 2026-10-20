# Getting Started

HyAPI v0.5.0 exposes declarative HTTP modules through `hyapi`. Bun 1.4 develops and builds the workspace; built ESM runs on Node 24+ or Bun. A local build does not prove npm publication.

## Try the example

From the repository root, start PostgreSQL 16, then inject `DATABASE_URL` and a random `JWT_SECRET` of at least 32 UTF-8 bytes:

```sh
docker run -d --name hyapi-postgres -e POSTGRES_PASSWORD=local -e POSTGRES_DB=hyapi -p 15432:5432 postgres:16
bun install --frozen-lockfile
DATABASE_URL=postgresql://postgres:local@127.0.0.1:15432/hyapi JWT_SECRET="<your-random-secret>" bun run dev
```

On Windows, set both variables in your shell before `bun run dev`. The example listens on `127.0.0.1:8000` unless `HOST` or `PORT` is set. No implicit `.env` loading; opt in with `bun --env-file=.env run dev`. See [configuration](/guide/configuration).

## Minimal application

With `hyapi`, `@inferdi/inferdi`, and `valibot` available to your project:

```ts
import { Container } from "@inferdi/inferdi";
import { createApp } from "hyapi";
import * as v from "valibot";

const container = new Container();
const app = createApp({
  container,
  modules: ({ module }) => [
    module({
      name: "hello",
      prefix: "/hello",
      routes: (route) => [
        route.get("/", {
          response: v.object({ hello: v.literal("world") }),
          handler: () => ({ hello: "world" as const }),
        }),
      ],
    }),
  ],
});

try {
  const response = await app.fetch(new Request("http://localhost/hello/"));
  console.log(await response.json());
} finally {
  await app.close();
  await container.dispose();
}
```

`app.fetch(request)` handles requests without opening a socket. `await app.listen({ port: 8000 })` starts a Bun or Node listener and returns `{ url, stop() }`; call `await app.close()` to stop listeners and drain accepted handlers, then dispose your container and other caller-owned resources. Import the package facade, not private Core paths.

## Next steps

- Define [routes and authorization](/guide/routes).
- Register [InferDI dependencies](/guide/composition).
- Configure [HTTP and OpenAPI](/guide/http-and-openapi).
- Migrate [older API consumers](/guide/migration-to-0.5).
