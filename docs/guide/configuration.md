# Configuration

`defineConfig()` validates application settings once and supplies safe defaults.

```ts
import { defineConfig } from "@hyapi/core";

const config = defineConfig({
  name: "items-api",
  bodyLimitBytes: 1_048_576,
  requestTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000,
  openapi: {
    defaultDocument: "public",
    documents: [
      { id: "public", path: "/openapi.json", title: "Items API" },
      { id: "internal", path: "/openapi-internal.json", title: "Items Internal API" },
    ],
  },
});
```

## Environment

`environment` defaults to `production`. Set it to `development` locally to include internal error
messages and details in problem responses: a thrown error's message and stack, or the issues behind
a response contract or validation failure. `test` and `production` keep internal errors hidden.
Never use `development` where clients are untrusted.

## Request and shutdown limits

`bodyLimitBytes` applies even when a client streams a body without `Content-Length`. A request that
outlives `requestTimeoutMs` receives a timeout response and its `AbortSignal` is aborted. During
`app.close()`, `shutdownTimeoutMs` bounds request draining and resource cleanup.

## Problem types

Error responses are RFC 9457 `application/problem+json` documents. Their `type` is `about:blank`
unless `problemTypeBaseUrl` is set, in which case it is `<base>/<lowercase code>`, for example
`https://errors.example.com/not_found`.

## Module configuration

Module settings are not part of `defineConfig()`. Each module declares its own schema and receives
values through `createApplication({ moduleConfig })`; see
[Composition](/guide/composition#module-configuration).

## Multiple OpenAPI documents

Every route is eligible for the `defaultDocument` unless it declares `metadata.documentIds`.

- Omit `documentIds` to include the route only in `defaultDocument`.
- Provide document IDs to include the route only in those named documents.
- Provide an empty array to exclude the route from every document.

Set `openapi.enabled` to `false` when the application should not serve OpenAPI documents.
