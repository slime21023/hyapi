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

## Request and shutdown limits

`bodyLimitBytes` applies even when a client streams a body without `Content-Length`. A request that
outlives `requestTimeoutMs` receives a timeout response and its `AbortSignal` is aborted. During
`app.close()`, `shutdownTimeoutMs` bounds request draining and resource cleanup.

## Multiple OpenAPI documents

Every route is eligible for the `defaultDocument` unless it declares `metadata.documentIds`.

- Omit `documentIds` to include the route only in `defaultDocument`.
- Provide document IDs to include the route only in those named documents.
- Provide an empty array to exclude the route from every document.

Set `openapi.enabled` to `false` when the application should not serve OpenAPI documents.
