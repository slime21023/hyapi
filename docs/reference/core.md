# Core API reference

Import public values and types from `hyapi`. Use an application-owned `@inferdi/inferdi` container and a Standard Schema v1 library (Valibot in the repository examples). `packages/core/src/` and Elysia are not consumer entry points. The generic container bound shown below is an **internal constraint**, not a type consumers import; let TypeScript infer it from your container.

## Application

### `createApp` and `ApplicationOptions<C>`

```ts
createApp<C extends RootContainer>(options: ApplicationOptions<C>): Application
```

`ApplicationOptions<C>` requires `container: C` and `modules: ({ module: ModuleBuilder<C> }) => readonly ModuleDefinition[]`; `openapi?: OpenApiOptions` is optional. `onError?: (error: unknown, request: Request) => void | Promise<void>` observes every failure sent as a private 500 (handler, authentication, response-validation, undeclared-reply, and scope-cleanup errors); it is not called for 4xx or 503 responses, cannot change the response, is not awaited, and must handle its own failures. The application **does not** construct or dispose your root container. Choose your own module boundaries; see [Modules and routes](../guide/modules.md).

### `Application`, `CloseOptions`, `ListenOptions`, and `Listener`

- **`Application`** — `fetch(request: Request): Promise<Response>` handles requests in process; `listen(options: ListenOptions): Promise<Listener>` binds HTTP; `close(options?: CloseOptions): Promise<void>` stops admission/listeners and drains accepted handlers without disposing the root.
- **`CloseOptions`** — `timeoutMs?: number` (non-negative, finite) rejects that `close` call with `Application close timed out.` once the deadline passes; accepted handlers are not cancelled and keep draining.
- **`ListenOptions`** — `port: number` required; `hostname?: string`; `fetch?: (request: Request) => Response | Promise<Response>` is an application-owned outer HTTP wrapper. No implicit middleware or edge policy.
- **`Listener`** — `url: URL` is the bound address; `stop(): Promise<void>` stops that listener. Binding a port that is already in use rejects on both Bun and Node; HyAPI does not enable port sharing (`SO_REUSEPORT`).

After `close()` starts, new `app.fetch` requests receive 503 `APPLICATION_UNAVAILABLE`; a new `listen` fails. The application disposes its root and other owned resources afterwards. [Dependency injection and lifecycle](../guide/di-lifecycle.md) covers scopes, streams and shutdown.

## Modules

- **`ModuleBuilder<C>`** — overloaded callable builder: `(options: PublicModule<C>) => ModuleDefinition` or `<I>(options: ProtectedModule<C, I>) => ModuleDefinition`. `I` is inferred from the protected module's `authenticate` return value.
- **`PublicModule<C>`** — `name: string`, `prefix: string`, and `routes: (route: RouteApi<C, undefined>) => readonly RouteDefinition[]`; cannot declare `authenticate` or `security`.
- **`ProtectedModule<C, I>`** — the same required fields with `routes: (route: RouteApi<C, I>) => readonly RouteDefinition[]`, plus required `authenticate: (request: Request, root: C) => I | Promise<I>` and optional `security?: string`.
- **`ModuleDefinition`** — a builder's produced declaration: `name`, `prefix`, and `readonly routes: readonly RouteDefinition[]`; optional `security` and request-only `authenticate`. Usually consumed via `modules`, not built by hand.

Protected `authenticate` runs before parsing/validation and supplies the route's typed `identity`; when OpenAPI is enabled, its `security` must name a declared scheme. See [Authentication and authorization](../guide/auth.md).

## Routes

- **`RouteApi<C, I>`** — `get`, `post`, `put`, `patch`, `delete` each accept `path` and `RouteOptions<C, I, ...>` and produce a `RouteDefinition`. Input/output schema and `scoped` type parameters are inferred at the call.
- **`RouteDefinition`** — registration result containing the HTTP `method` (`"GET" | "POST" | "PUT" | "PATCH" | "DELETE"`), `path`, and `options`; do not mutate or construct it to bypass route validation.
- **`RouteOptions<C, I, Params, Query, Body, R, Scoped>`** — optional `params`, `query`, `body` Standard Schema v1 validators; optional singular `response` schema or numeric-status schema map; optional `scoped`, `authorize`, `summary`, `description`, `tags`, and `operationId` (non-empty and unique per application, checked at composition). `handler` is required. Omitted schema type parameters default to `undefined`; omitted `Scoped` defaults to `false`.
- **`RouteContext<C, I, Params, Query, Body, Scoped>`** — readonly `request`, typed `root: C`, `identity: I`, validated `params`, `query`, `body`, and `scope` only when `Scoped` is `true`. Without a `params`/`query` schema their types are `Record<string, string>`; absent `body` is typed `unknown`.

`authorize(context)` returns `void | Promise<void>` and runs after validation but before `handler(context)`; the handler returns `HandlerResult<R>` or a promise of it. `scope` is lazy and requires `scoped: true`. For accepted route syntax and path conflicts, see [Modules and routes](../guide/modules.md); for response/error behavior, see [HTTP inputs, responses, and errors](../guide/http.md).

## Schemas and replies

- **`Schema`** — alias for a Standard Schema v1 object; HyAPI validates route inputs/outputs with this contract.
- **`SchemaOutput<S>`** — infers a `Schema`'s output type; otherwise `unknown`.
- **`HandlerResult<R>`** — for a single response schema, validated value or Web `Response`; for a numeric-status schema map, the matching `Reply` values, a plain output if 200 is declared, or Web `Response`; without a declared schema, `unknown`.
- **`Reply<Status, Value>`** — opaque branded successful status/value pair returned by `reply`; do not construct it by hand.

```ts
reply<Status extends number, Value>(status: Status, value: Value, options?: ReplyOptions): Reply<Status, Value>
```

`reply` accepts integer 200–399; a non-default status must be in the route's response map. `ReplyOptions.headers?: HeadersInit` adds response headers (for example `Location` or several `Set-Cookie` values) while the value is still schema-validated; an explicit `content-type` replaces the JSON default. Malformed header names throw `TypeError` when `reply` is called, and reply headers are dropped if the response then fails. Errors use exceptions rather than `reply(4xx, ...)`.

## OpenAPI

`OpenApiOptions` requires `path: string` and `info: { title: string; version: string; description?: string }`. Optional `securitySchemes` maps names to `{ type: string; scheme?: string; bearerFormat?: string }`. Optional `converters` maps Standard Schema vendor names to `(schema: Schema) => object` JSON Schema converters. JSON is served at `${path}/json` only when `openapi` is supplied to `createApp`; the framework does not provide a separate documentation UI. Valibot has built-in conversion. See [OpenAPI](../guide/openapi.md) for converter and security-scheme requirements.

## Errors

```ts
new HttpError(status: number, message: string, code?: string)
new UnauthorizedError(message?: string)
new ForbiddenError(message?: string)
```

`HttpError` accepts only integer 400–599 and defaults to `code: "HTTP_ERROR"`. `UnauthorizedError` returns 401 with `UNAUTHORIZED` (default message `"Authentication is required."`); `ForbiddenError` returns 403 with `FORBIDDEN` (default message `"Permission denied."`). `Problem` is the public readonly response shape: `{ type: string; title: string; status: number; detail: string; code: string; errors?: readonly ProblemIssue[] }`. `ProblemIssue` is `{ in: "params" | "query" | "body"; pointer: string; message: string }`, where `pointer` is an RFC 6901 JSON Pointer; `errors` appears only on 400 `VALIDATION_ERROR` responses whose issues a synchronous schema could list. Its HTTP representation uses `application/problem+json`; unexpected internal errors are reported without the exception's private detail. See [HTTP inputs, responses, and errors](../guide/http.md).
