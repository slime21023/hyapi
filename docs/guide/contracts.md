# Contracts

A contract declares what the API promises: operations, their inputs and responses, and their
security. Contracts are TypeScript modules written with
[TypeBox](https://github.com/sinclairzx81/typebox) schemas, imported from `@hyapi/core/contract`.
They contain no implementation.

```ts
import Type from "typebox";
import {
  defineApi,
  defineContract,
  defineResponse,
  defineSchema,
  defineSecurity,
  httpBearer,
  Problem,
} from "@hyapi/core/contract";

const T = Type;
```

Applications depend on `typebox` directly, at the same 1.x minor version as `@hyapi/core`.

## Named schemas

```ts
export const Book = defineSchema(
  "Book",
  T.Object({ id: T.String({ format: "uuid" }), title: T.String({ minLength: 1 }) }),
);
export const CreateBook = defineSchema("CreateBook", T.Omit(Book, ["id"]));
```

A named schema becomes `#/components/schemas/<name>` in the emitted document and is referenced by
`$ref` wherever it appears, including inside schemas derived with `T.Omit` or `T.Partial`. Give
every object that crosses the wire a name: consumers' code generators turn names into type names.
`checkContracts` warns about unnamed object schemas.

Request and response views use separate schemas, as above. HyAPI gives `readOnly` and `writeOnly` no
special meaning.

Schemas must be representable in JSON Schema, because the emitted document must describe exactly
what the runtime enforces. Codecs, refinements, functions, and `undefined` are rejected. `format`
values must be standard formats that TypeBox checks (such as `uuid`, `email`, and `date-time`),
OpenAPI annotations (such as `int64` and `binary`), or formats declared on the API.

## Responses

```ts
export const NotFound = defineResponse("NotFound", {
  description: "The resource does not exist.",
  body: Problem,
});
```

A response is declared in one of three forms:

| Form      | Example                                             | Meaning                                             |
| --------- | --------------------------------------------------- | --------------------------------------------------- |
| Shorthand | `200: Book`                                         | A JSON body; the description is the reason phrase   |
| Full      | `201: { description, body?, mediaType?, headers? }` | Custom description, headers, media type, or no body |
| Named     | `404: NotFound`                                     | A reusable response under `#/components/responses`  |

A body of `Problem` (RFC 9457) uses `application/problem+json`. Declared response headers are
required in handler results.

## Security schemes

```ts
export const security = defineSecurity({
  bearer: httpBearer<{ subject: string }>({ bearerFormat: "JWT" }),
});
```

The type parameter is the identity that the scheme's verifier returns. The constructors are
`httpBearer`, `httpBasic`, `apiKey`, `oauth2`, and `openIdConnect`. See [Security](./security).

## Operations

```ts
export const books = defineContract({
  securitySchemes: security,
  security: [{ bearer: ["books:write"] }], // the default for this contract
  tags: ["books"],
  operations: {
    getBook: {
      method: "GET",
      path: "/books/{id}",
      summary: "Get a book",
      security: [], // public
      params: T.Object({ id: T.String({ format: "uuid" }) }),
      responses: { 200: Book, 404: NotFound },
    },
    createBook: {
      method: "POST",
      path: "/books",
      body: CreateBook,
      responses: { 201: Book },
    },
  },
});
```

| Field                                          | Meaning                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `method`, `path`                               | Required. Path template parameters must match `params`; the type checker reports mismatches.          |
| `params`, `query`, `headers`, `cookies`        | One `T.Object` per location. Property `description` and `deprecated` are documented on the parameter. |
| `styles`                                       | Overrides parameter serialization, for example `{ query: { ids: { explode: false } } }`.              |
| `body`                                         | A schema (a required JSON body) or `{ schema, mediaType?, required?, description? }`.                 |
| `responses`                                    | One entry per status.                                                                                 |
| `security`                                     | Alternatives (OR) of requirements (AND); `[]` makes the operation public.                             |
| `summary`, `description`, `tags`, `deprecated` | Documentation, emitted unchanged.                                                                     |

The keys of `operations` are the `operationId`s. An operation's security is its own `security`, else
the contract's `security`, else the API's root `security`, else none.

### Parameters

Parameters arrive as strings and are coerced to their schema types before validation. Supported
styles are path `simple`; query `form` (with or without `explode`) and `deepObject`; header
`simple`; and cookie `form`.

A parameter with a default declared through `T.With` is required in the handler's input, because the
runtime fills it in:

```ts
query: T.Object({ limit: T.Optional(T.With(T.Integer({ maximum: 100 }), { default: 20 })) });
// handler: query.limit is number
```

A default passed as a constructor option (`T.Integer({ default: 20 })`) is applied as well, but
TypeBox does not carry it in the type, so the parameter stays optional for the handler.

## The API

```ts
export const api = defineApi({
  info: { title: "Library API", version: "1.2.0" },
  servers: [{ url: "https://api.example.com" }],
  securitySchemes: security,
  contracts: [books, system],
});
```

Contracts that declare `securitySchemes` must use the same `defineSecurity` value as the API. Split
large APIs into one contract per resource: editor feedback depends on the size of a contract, not of
the whole API.

### Custom formats

Declare a check for every custom `format` on the API, so that the CLI, the runtime, and the emitted
document agree:

```ts
const isIsbn = (value: string) => /^97[89]\d{10}$/.test(value);

export const api = defineApi({
  info: { title: "Library API", version: "1.2.0" },
  formats: { isbn: isIsbn },
  contracts: [books],
});

// In a schema:
T.String({ format: "isbn" });
```

`createApp` registers the checks with TypeBox, whose format names are shared by the whole process:
two APIs in one process that declare the same name must pass the same function, or startup fails
with `format-conflict`.

## Diagnostics

`checkContracts(api)` returns `{ ok, diagnostics }`. `createApp`, `hyapi emit`, and `hyapi doctor`
all run the same checks, so the same messages appear everywhere, and the result never depends on
what else runs in the process. Each diagnostic has a stable `code`, for example `duplicate-route`,
`path-parameter-mismatch`, `unknown-format`, or `unnamed-schema` (a warning).
