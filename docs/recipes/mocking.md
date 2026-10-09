# Mocking with Prism

Consumers can start integrating as soon as a contract is merged, before the implementation exists.
HyAPI does not include a mock server; [Prism](https://stoplight.io/open-source/prism) serves one
from the committed document.

```sh
npx @stoplight/prism-cli mock openapi.json
```

Prism answers each operation with an example generated from its response schema, and validates
requests against the document. Add `examples` to your schemas to control the answers:

```ts
export const Book = defineSchema(
  "Book",
  T.Object({
    id: T.String({ format: "uuid" }),
    title: T.String({ examples: ["The Left Hand of Darkness"] }),
  }),
);
```

## In the real service

Operations that are not implemented yet can use `notImplemented`, which answers 501 with a problem
body and is listed at startup, so the contract and the service can be merged independently.
