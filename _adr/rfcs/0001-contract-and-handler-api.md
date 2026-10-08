# RFC 0001: Contract and handler API

- Status: Accepted (2026-10-08), after the type-performance validation in §9 passed.
- Date: 2026-10-08
- Components: [contract](../components/contract.md), [runtime](../components/runtime.md)
- Decisions: [ADR 0001](../0001-contract-first-api-library.md),
  [ADR 0002](../0002-architecture-and-component-boundaries.md)

## Summary

This RFC defines how developers write contracts and handlers: the public API that carries HyAPI's
signature value, the native type experience. Contracts are plain object literals in two levels: one
`defineApi` per API, and one `defineContract` per resource. Named schemas, responses, and security
schemes are declared with `define*` functions. Handlers take `(input, ctx)`, return
`{ status, body, headers }` unions, and are bound per contract with `implement`.

## 1. Complete example

```ts
// contracts/security.ts
export const security = defineSecurity({
  bearer: httpBearer<{ subject: string }>(),
});

// contracts/schemas.ts
export const User = defineSchema(
  "User",
  T.Object({
    id: T.String({ format: "uuid" }),
    name: T.String({ minLength: 1 }),
    email: T.String({ format: "email" }),
  }),
);
export const CreateUser = defineSchema("CreateUser", T.Omit(User, ["id"]));

export const NotFound = defineResponse("NotFound", {
  description: "The resource does not exist.",
  body: Problem,
});
export const Conflict = defineResponse("Conflict", {
  description: "The request conflicts with the current state.",
  body: Problem,
});

// contracts/users.ts
export const users = defineContract({
  securitySchemes: security,
  tags: ["users"],
  operations: {
    getUser: {
      method: "GET",
      path: "/users/{id}",
      summary: "Get a user",
      security: [{ bearer: ["users:read"] }],
      params: T.Object({ id: T.String({ format: "uuid" }) }),
      responses: { 200: User, 404: NotFound },
    },
    createUser: {
      method: "POST",
      path: "/users",
      summary: "Create a user",
      security: [{ bearer: ["users:write"] }],
      body: CreateUser,
      responses: {
        201: { description: "Created", body: User, headers: T.Object({ location: T.String() }) },
        409: Conflict,
      },
    },
    deleteUser: {
      method: "DELETE",
      path: "/users/{id}",
      security: [{ bearer: ["users:write"] }],
      params: T.Object({ id: T.String({ format: "uuid" }) }),
      responses: { 204: { description: "Deleted" }, 404: NotFound },
    },
  },
});

// contracts/api.ts
export const api = defineApi({
  info: { title: "Users API", version: "1.2.0" },
  servers: [{ url: "https://api.example.com" }],
  securitySchemes: security,
  contracts: [users, orders],
});
```

```ts
// src/users/get-user.ts: a handler in its own file
export const getUser: Handler<typeof users, "getUser"> = async ({ params }, ctx) => {
  const user = await repo.find(params.id, { signal: ctx.signal });
  return user
    ? { status: 200, body: user }
    : { status: 404, body: problem({ title: "User not found", detail: `No user ${params.id}` }) };
};

// src/users/mod.ts
export const usersImplementation = (deps: Deps) =>
  implement(users, {
    getUser,
    createUser: async ({ body }) => {
      const user = await deps.users.create(body);
      return { status: 201, body: user, headers: { location: `/users/${user.id}` } };
    },
    deleteUser: notImplemented,
  });

// src/main.ts
const app = await createApp({
  api,
  implementations: [usersImplementation(deps), ordersImplementation(deps)],
  verifiers: { bearer: jwtBearer({ secret }) },
});
serve(app);
```

## 2. API and contract structure

- **`defineApi`** is declared once per API. It holds `info`, `servers`, `securitySchemes`, an
  optional root `security` requirement, and the list of `contracts`. It is the single entry point
  for `createApp` and `hyapi emit`.
- **`defineContract`** is declared once per resource module. It holds `operations`, optional default
  `tags`, and an optional default `security` requirement (amendment A1). It references the same
  `securitySchemes` module as the API, so scheme names are checked at compile time without importing
  the API module, which would be a cycle. Scopes are checked by diagnostics (A3).
- Operations are an object literal keyed by `operationId`. A builder chain was rejected: object
  literals are plain data, closest to OpenAPI, and easiest to review.
- Diagnostics check that every contract uses the same `securitySchemes` module as `defineApi`.

## 3. Operations

| Field                                          | Form                                                           | Notes                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `method`, `path`                               | `"GET"`, `"/users/{id}"`                                       | Required. Path template parameters must match `params` keys, checked at type level and by diagnostics.                                |
| `params`, `query`, `headers`, `cookies`        | `T.Object({...})`                                              | One object schema per location. Property options (`description`, `deprecated`, `examples`) become parameter documentation.            |
| `body`                                         | a schema, or `{ schema, mediaType?, required?, description? }` | A bare schema is a required `application/json` body.                                                                                  |
| `responses`                                    | status → shorthand or full form                                | See §4.                                                                                                                               |
| `security`                                     | `[{ scheme: [scopes] }, ...]`                                  | Alternatives are OR; schemes within one entry are AND. `[]` marks a public operation. Omitted means the API root requirement applies. |
| `summary`, `description`, `tags`, `deprecated` | documentation metadata                                         | Emitted unchanged. Contract-level `tags` apply to every operation unless overridden.                                                  |

Further details:

- Parameter style overrides use an optional `styles` field, for example
  `styles: { query: { ids: { style: "form", explode: false } } }`. Defaults follow OpenAPI, and
  unsupported styles fail diagnostics.
- The handler input contains only the locations that the operation declares.

## 4. Responses

- **Shorthand:** `200: User`. A schema value means an `application/json` body. The description
  defaults to the HTTP reason phrase.
- **Full form:** `{ description, body?, mediaType?, headers? }`. Use it for custom descriptions,
  response headers, other media types, or no body (`204: { description: "Deleted" }`).
- **Named responses:** `defineResponse("NotFound", { ... })` declares a reusable response. It is
  emitted under `#/components/responses` and referenced by `$ref`.
- **Problem responses:** HyAPI exports a built-in `Problem` schema (RFC 9457) and a `problem()`
  helper. A response whose body is `Problem` uses `application/problem+json`. `problem()` leaves
  `status` out, and the runtime fills it from the returned status.

## 5. Named schemas

`defineSchema("User", schema)` attaches a component name to a TypeBox schema at its definition. The
name travels with the schema across modules, so no central registry is needed. Normalization
collects every named schema reachable from the API. A name used for two different schemas is a
diagnostic error, and an unnamed object schema at a request or response top level is a warning. The
`define*` prefix is used for everything that appears by name in the emitted document: `defineApi`,
`defineContract`, `defineSchema`, `defineResponse`, and `defineSecurity`.

## 6. Security schemes and identities

- `defineSecurity({ ... })` declares scheme names with typed constructors: `httpBearer<Identity>()`,
  `httpBasic<Identity>()`, `apiKey<Identity>({ in, name })`, `oauth2<Identity>({ flows })`, and
  `openIdConnect<Identity>({ url })`. The type parameter declares the identity that the scheme's
  verifier returns. It exists only in types.
- Operation `security` entries are type-checked against the declared scheme names, and against
  declared scopes where the scheme declares them.
- `createApp({ verifiers })` requires exactly one verifier per scheme, typed as
  `Verifier<typeof security, "bearer">`. A verifier receives the extracted credential and the
  request context and returns the identity plus its granted scopes.
- `ctx.security` is typed per operation as the union of its alternatives, for example
  `{ bearer: { subject: string } } | { apiKey: ... }`. A public operation has no security value.

## 7. Handlers

- **Signature:** `(input, ctx) => Promise<Result> | Result`.
  - `input` holds only validated data: `params`, `query`, `headers`, `cookies`, and `body`, as
    declared.
  - `ctx` holds runtime information: `signal`, `security`, `request` (the raw `Request`), and
    `operationId`.
  - A unit test only needs to build `input` and a minimal `ctx`.
- **Result:** the union of the declared responses, each `{ status, body?, headers? }`. Declared
  response headers are required by type. A handler may also return a raw `Response` for streams and
  files; its status must still be declared.
- **Declared outcomes are returned, not thrown.** `HttpError` is for cross-cutting or unexpected
  failures only.
- **`implement(contract, handlers)`** binds one contract module. The handler map must contain every
  `operationId` of that contract. `notImplemented` stands in for operations without a handler yet.
- **`Handler<typeof contract, "operationId">`** types a handler that is defined outside the
  `implement` call. It has no runtime cost.
- **`createApp({ api, implementations, verifiers, ...options })`** requires exactly one
  implementation per contract in the API. A missing, duplicated, or foreign implementation is a
  startup diagnostic.

## 8. Public names

| Entry point            | Names                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@hyapi/core/contract` | `defineApi`, `defineContract`, `defineSchema`, `defineResponse`, `defineSecurity`, `httpBearer`, `httpBasic`, `apiKey`, `oauth2`, `openIdConnect`, `Problem`, `checkContracts`, and inference types |
| `@hyapi/core`          | `createApp`, `implement`, `notImplemented`, `problem`, `HttpError`, `Handler`, `Verifier`, and option and event types                                                                               |

`Problem` lives in the contract entry because contracts reference it. `problem()` lives in the
runtime entry because only handlers build problem values.

## 9. Validation before acceptance: type performance

The native type experience is the signature value, so this API was accepted only after a throwaway
spike showed that it scales. The spike:

- generates APIs of 50, 200, and 500 operations in the shape of §1, with realistic schemas, named
  responses, and security;
- measures full `deno check` time and the incremental editor response after one operation changes;
  and
- confirms that no "type instantiation is excessively deep" errors appear at 500 operations.

Acceptance targets: full check of 200 operations within 5 seconds, and editor feedback within 1
second. If the targets are missed, the inference design changes before any implementation starts.

### Results (2026-10-08)

The spike passed. Details are in the [type-performance baseline](../baselines/type-performance.md).

| Measurement                                 | Target | Result                                            |
| ------------------------------------------- | ------ | ------------------------------------------------- |
| Full `deno check`, 200 operations           | ≤ 5 s  | 1.47 s (500 operations: 2.17 s)                   |
| Editor feedback after an edit               | ≤ 1 s  | 148–167 ms (100-operation contract: up to 293 ms) |
| Deep-instantiation errors at 500 operations | none   | none                                              |

The spike changed the design in three places, and the implementation must keep these changes:

- `implement` wraps its handler map in `NoInfer`. Otherwise, handlers written inline lose their
  literal `status` types.
- The response shorthand is recognized by TypeBox's `~kind` marker, because TypeBox's `TSchema` is
  structurally empty.
- The path-parameter diagnostic type should name the missing or extra parameters.

## 10. Amendments made during implementation (M1)

These changes were decided while implementing the contract component. They are part of the accepted
API.

- **A1. Contract-level default security.** `defineContract({ security })` sets a default requirement
  for its operations. An operation's effective requirement is resolved in this order: its own
  `security`, then the contract default, then the API root requirement, and otherwise none. Types
  follow the first two, so `ctx.security` is precise unless the operation inherits the API root. An
  inherited root requirement types every scheme as optional, because a contract cannot see the API
  that lists it.
- **A2. Parameter defaults.** The runtime fills in an absent query, header, or cookie parameter from
  its schema `default`. Bodies are never modified. TypeBox does not carry options such as `default`
  in its types. A default declared with `T.With(schema, { default })` therefore makes the parameter
  required in the handler input. A default passed as a constructor option, such as
  `T.Integer({ default: 20 })`, is still applied at runtime, but the parameter stays optional in
  types.
- **A3. Scopes are checked by diagnostics only.** TypeScript cannot infer OAuth 2 scopes from
  `flows` while the identity type is given explicitly. `checkContracts` reports scopes that no flow
  declares (`undeclared-scope`), and requirement values are typed as `readonly string[]`.
- **A4. `checkContracts` takes the API.** Its signature is `checkContracts(api)`, which returns
  `{ ok: true, model, diagnostics }` or `{ ok: false, diagnostics }`. The model is present only when
  there are no errors. Warnings, such as `unnamed-schema`, never fail the check.
- **A5. `Problem` follows RFC 9457 exactly.** Every member is optional, and extension members are
  allowed. `problem()` (M2) may still require a `title`.
- **A6. Applications import TypeBox directly.** HyAPI does not re-export `T`. Applications depend on
  `typebox` at the same 1.x minor version as `@hyapi/core`.
- **A7. Delivery order.** `Handler`, `implement`, and `notImplemented` are delivered with the
  contract component in M1 so that the type contract can be tested in full. `createApp` and
  `Verifier` remain in M2 and M4.

## 11. Amendments made during implementation (M2)

- **A8. Empty input.** An operation without parameters or a body gives its handler an empty object
  as input, so `(_input, ctx) => ...` type-checks.
- **A9. Additional public names.** `@hyapi/core` also exports `StartupError` (thrown by `createApp`
  with every diagnostic), `ProblemValue`, `ProblemCode`, `Violation`, and `ResponseValidation`.

## 12. Amendments made during implementation (M3)

- **A10. Names survive derivation.** A schema named with `defineSchema` keeps its name wherever
  TypeBox copies it, for example inside `T.Omit(Book, ["id"])`, so the emitted document uses a
  `$ref` there too. A derived top-level schema is unnamed until it is given its own `defineSchema`
  name.

## Alternatives rejected

- **A single contract that holds everything:** large APIs would assemble operations with object
  spreads and lose per-module type-check boundaries.
- **Builder chains:** not plain data, harder to review, and heavier type computation.
- **Responses only in full form, or in OpenAPI's raw `content` form:** consistent, but verbose for
  the common JSON case.
- **A component registry in `defineApi`, or TypeBox `$id`:** a registry can be forgotten. `$id`
  carries URI semantics in JSON Schema.
- **A single handler argument:** it mixes validated data and runtime context.
- **One `implement` for the whole API:** it concentrates type expansion and handler code in one
  object.
- **A `handler(contract, id, fn)` wrapper:** a second runtime API for something a type annotation
  covers.
- **oRPC-style typed error maps thrown from handlers:** this conflicts with returning declared
  outcomes.
- **A uniform `Identity` type, or global module augmentation:** these give weaker types, or rely on
  global type state.
- **Path parameter checks only in diagnostics:** they delay feedback that the type system can give
  for free.
