# Testing

An application is a `fetch` function, so tests call it directly. No port, no server.

```ts
import { assertEquals } from "@std/assert";
import { createApp } from "@hyapi/core";
import { api } from "../contracts/api.ts";
import { booksImplementation } from "../src/books.ts";

const app = await createApp({ api, implementations: [booksImplementation(new FakeRepository())] });

Deno.test("returns 404 as a problem", async () => {
  const response = await app.fetch(
    new Request("http://test/books/00000000-0000-0000-0000-000000000000"),
  );
  assertEquals(response.status, 404);
  assertEquals(response.headers.get("content-type"), "application/problem+json");
  await response.body?.cancel();
});
```

Tests through `app.fetch` exercise everything a client sees: routing, security, validation, response
stripping, and serialization. Create the app with `development: true` to make responses that break
the contract fail with 500 and list their violations.

## Testing handlers alone

Handlers are plain functions. Give them `input` and a minimal `ctx`:

```ts
const handler = booksImplementation(repository).handlers.getBook;
```

Prefer tests through `app.fetch` for anything that depends on the contract, and handler tests for
business logic.

## Secured operations

Pass test verifiers instead of real ones:

```ts
const testBearer: Verifier<typeof security, "bearer"> = (token) =>
  token === "test" ? { identity: { subject: "tester" }, scopes: ["books:write"] } : null;

const app = await createApp({ api, implementations, verifiers: { bearer: testBearer } });
```

## Contract types

Type errors are part of the contract. A test file can assert that invalid handlers are rejected with
`// @ts-expect-error`; `deno test` type-checks it and fails if the expected error disappears.
