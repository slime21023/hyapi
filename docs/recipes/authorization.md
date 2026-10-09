# Authorization

HyAPI decides **who** the caller is and whether their credentials carry the **scopes** an operation
declares. Decisions that need data, such as "only the owner or an admin", belong to the application.
This recipe keeps them in one place without middleware.

## Roles as scopes

A verifier can map roles to scopes, so per-operation role checks live in the contract and appear in
the emitted document:

```ts
const session: Verifier<typeof security, "session"> = async (sessionId, ctx) => {
  const user = await sessions.find(sessionId, { signal: ctx.signal });
  if (user === undefined) return null;
  return { identity: user, scopes: user.roles }; // for example ["reader", "admin"]
};
```

```ts
deleteBook: {
  method: "DELETE",
  path: "/books/{id}",
  security: [{ session: ["admin"] }],
  params: T.Object({ id: T.String() }),
  responses: { 204: { description: "Deleted" }, 403: Problem },
},
```

A reader then gets 403 `FORBIDDEN` before the handler runs, and the operation's `security.denied`
event records `reason: "insufficient-scope"` with `requiredScopes: ["admin"]`.

A verifier can also refuse a credential that is valid but not allowed, such as a suspended account,
by throwing `HttpError`. That answers with its status and ends security evaluation:

```ts
if (user.suspended) throw new HttpError(403, { code: "ACCOUNT_SUSPENDED" });
```

## Resource rules as typed handler wrappers

Rules about a specific resource need the resource, so they run in the handler. Write them once as a
function that wraps handlers. `Handler<C, K>` keeps the wrapped handler fully typed:

```ts
import { type Handler, HttpError } from "@hyapi/core";
import { books } from "../contracts/books.ts";

type BookHandler<K extends "updateBook" | "deleteBook"> = Handler<typeof books, K>;

/** Lets the owner of the book, or an admin, call the operation. */
function ownerOrAdmin<K extends "updateBook" | "deleteBook">(
  handler: BookHandler<K>,
): BookHandler<K> {
  return async (input, ctx) => {
    const user = ctx.security.session;
    const book = await repository.get(input.params.id, { signal: ctx.signal });
    if (book !== undefined && book.ownerId !== user.id && !user.roles.includes("admin")) {
      throw new HttpError(403, { code: "NOT_OWNER" });
    }
    return await handler(input, ctx);
  };
}

export const handlers = implement(books, {
  updateBook: ownerOrAdmin(async ({ params, body }) => {/* ... */}),
  deleteBook: ownerOrAdmin(async ({ params }) => ({ status: 204 })),
  // ...
});
```

Declare the 403 in the contract, so that clients and the document know about it. An `HttpError`
whose status the contract does not declare still answers, but the response contract does not
describe it.

## Auditing

Every denial by HyAPI is a `security.denied` event, and every handler decision ends in
`operation.end` with its status and `code`:

```ts
onEvent: (event) => {
  if (event.type === "security.denied" || (event.type === "operation.end" && event.status === 403)) {
    audit.write(event);
  }
},
```

Events never contain credentials. With `createApp({ requestId: true })`, every event carries the
request's ID, so a denial can be joined with the rest of the request's logs.
