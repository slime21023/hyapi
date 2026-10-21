# HyAPI

HyAPI is a typed HTTP framework for modular applications. The `hyapi` package composes routes, Standard Schema validation, and optional OpenAPI over an application-owned InferDI container. Elysia stays behind the public API.

Version 0.5.0 is unreleased. This quickstart runs from the repository workspace, not an npm installation.

## Quickstart

<!-- #region quickstart -->

Requires Bun 1.4.0 and Node 24+. From the repository root:

```sh
bun install --frozen-lockfile
bun run --filter hyapi build
```

Create `hello.ts` in the repository root. Define the response schema and route first, then compose the module and application:

```ts
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, type ModuleBuilder, type RouteApi } from "hyapi";

const container = new Container().registerValue("message", "Hello from HyAPI");
type AppContainer = typeof container;
const responseSchema = v.object({ message: v.string() });

function helloRoute(route: RouteApi<AppContainer, undefined>) {
  return route.get("/", {
    response: responseSchema,
    handler: ({ root }) => ({ message: root.get("message") }),
  });
}

function helloModule(module: ModuleBuilder<AppContainer>) {
  return module({
    name: "hello",
    prefix: "/hello",
    routes: (route) => [helloRoute(route)],
  });
}

const app = createApp({
  container,
  modules: ({ module }) => [helloModule(module)],
});

const listener = await app.listen({ hostname: "127.0.0.1", port: 3000 });
console.log(`Listening at ${listener.url}`);
process.once("SIGINT", () => {
  void (async () => {
    try {
      await app.close();
    } finally {
      await container.dispose();
    }
  })();
});
```

Start the server:

```sh
bun hello.ts
```

In another terminal, send a request (use `curl.exe` in Windows PowerShell):

```sh
curl http://127.0.0.1:3000/hello/
```

Expected response: `{"message":"Hello from HyAPI"}`. Stop the server with Ctrl+C. `app.close()` stops listeners and drains accepted handlers; the caller disposes the InferDI root separately.

<!-- #endregion quickstart -->

For multi-module composition, authentication, and PostgreSQL transactions, see the private [ERP example](apps/example/src/app.ts).

The [official documentation source](docs/index.md) is available now. The [documentation website](https://slime21023.github.io/hyapi/) is planned; its deployment has not yet been verified.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release directions, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and the [changelog](CHANGELOG.md) for release status.

License: [MIT](LICENSE).
