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

When the status depends on a condition, return one object per status:

```ts
return ok ? { status: 200, body: report } : { status: 503, body: report };
```

A single object such as `{ status: ok ? 200 : 503, body }` does not type-check, because handlers may
also return a raw `Response`, and TypeScript cannot split the status union across both.

A handler may return a raw `Response` for streams or files. Its status must still be declared; its
body is neither buffered nor validated.

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
