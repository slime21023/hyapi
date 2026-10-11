# Handlers

Handlers implement the operations of one contract. Their types come from the contract.

```ts
import { implement, notImplemented } from "@hyapi/core";
import { books } from "../contracts/books.ts";

export function booksImplementation(repository: BookRepository) {
  return implement(books, {
    getBook: ({ params }) => {
      const book = repository.get(params.id);
      return book
        ? { status: 200, body: book }
        : { status: 404, body: { title: "Book not found", detail: params.id } };
    },
    createBook: async ({ body }, ctx) => {
      const book = await repository.create(body, { signal: ctx.signal });
      return { status: 201, body: book };
    },
    deleteBook: notImplemented,
  });
}
```

`implement` requires exactly one entry per operation. `notImplemented` answers 501 and is listed at
startup, so a contract can be merged before its implementation. Dependencies reach handlers through
the closure: there is no container.

## Input and context

A handler receives `(input, ctx)`:

- `input` holds only validated data for the locations the operation declares: `params`, `query`,
  `headers`, `cookies`, and `body`. An operation without inputs gets an empty object.
- `ctx.signal` aborts on client disconnect, the request timeout, or shutdown. Pass it on to I/O.
- `ctx.security` holds the identities from the security requirement that succeeded, typed per
  operation, and is `undefined` for public operations.
- `ctx.request` is the raw `Request`; its body has already been read when the operation declares
  one. `ctx.operationId` names the operation.

## Results

A handler returns one of the operation's declared responses as `{ status, body?, headers? }`.
Undeclared statuses and wrong bodies are type errors.

A status may depend on a condition:

```ts
return { status: ok ? 200 : 503, body: report };
```

The body follows the declared media type:

| Declared media type                     | `body` may be                                   |
| --------------------------------------- | ----------------------------------------------- |
| JSON (the default, or `+json`)          | the schema's value                              |
| `text/*`, including `text/event-stream` | a `string` or a `ReadableStream<Uint8Array>`    |
| anything else, such as a file download  | a `Uint8Array`, a `Blob`, or a `ReadableStream` |

Headers that a response does not declare may have several values, which are sent as several headers:

```ts
return { status: 204, headers: { "set-cookie": ["session=abc; HttpOnly", "theme=dark"] } };
```

There is no raw `Response`: every response is a result object, so a mistake is reported where it is.
An undeclared status, for example, ends with:

```text
Types of property 'status' are incompatible.
  Type '201' is not assignable to type '200'.
```

Returning a `Response` anyway, from JavaScript, answers 500 `RESPONSE_CONTRACT_VIOLATION`. Streamed,
byte, and `Blob` bodies are not validated.

Before serialization, the runtime removes response properties that the schema does not declare, so
returning a database record cannot leak extra fields. For problem bodies it fills in `status`.

## Errors

Declared outcomes are **returned**, as above. For cross-cutting or unexpected failures, throw
`HttpError`:

```ts
throw new HttpError(409, { detail: "The book is on loan", code: "BOOK_ON_LOAN" });
```

It becomes a problem response with that status and code. Any other thrown value becomes a 500 whose
details are shown only in development mode.

## Handlers in their own files

`Handler` types a handler that is defined outside `implement`:

```ts
import type { Handler } from "@hyapi/core";

export const getBook: Handler<typeof books, "getBook"> = ({ params }) => {/* ... */};
```

## Testing

Handlers are plain functions, and the application is a `fetch` function, so tests need no server.
See [Testing](../recipes/testing).
