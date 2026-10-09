# Getting started

HyAPI turns a contract written in TypeScript into two things: a running HTTP application whose
handlers are type-checked against the contract, and an OpenAPI 3.1 document for every consumer of
the API. This page creates a project and walks through one change.

## Create a project

HyAPI needs Deno 2.9 or later.

```sh
deno run -A jsr:@hyapi/cli new my-api
cd my-api
deno task dev
```

The project looks like this:

```text
contracts/         the API contract: what the API promises
  api.ts           defineApi: info, security schemes, and the list of contracts
  greetings.ts     defineContract: the operations of one resource
src/               the implementation
  greetings.ts     implement(contract, handlers)
  app.ts           createApp
  main.ts          serve
tests/             tests that call app.fetch
openapi.json       the committed OpenAPI document, emitted from contracts/
deno.json          tasks and the hyapi configuration
```

| Task               | What it does                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| `deno task dev`    | Runs the server and reloads on changes                                        |
| `deno task emit`   | Writes `openapi.json` from the contracts                                      |
| `deno task verify` | Formats, lints, type-checks, tests, and checks that `openapi.json` is current |
| `deno task diff`   | Compares the contracts with `openapi.json` on `main`; breaking changes fail   |
| `deno task doctor` | Checks the contracts and the committed document without starting a server     |

## The workflow of a change

1. **Change the contract.** Add or change an operation in `contracts/`. The contract is plain data
   that reviewers can read before any handler exists.
2. **Follow the type errors.** The editor flags every handler that no longer matches. An operation
   without a handler yet can use `notImplemented`, which answers 501.
3. **Emit the document.** `deno task emit` rewrites `openapi.json`. Commit it with the change, so
   the pull request shows what consumers will receive.
4. **Verify.** `deno task verify` fails if `openapi.json` is stale, and `deno task diff` fails if
   the change breaks consumers. Use `--allow-breaking` only when the break is intended.

For example, add an operation:

```ts
// contracts/greetings.ts
export const greetings = defineContract({
  operations: {
    getGreeting: {/* ... */},
    listGreetings: {
      method: "GET",
      path: "/greetings",
      query: T.Object({ limit: T.Optional(T.With(T.Integer({ maximum: 50 }), { default: 10 })) }),
      responses: { 200: T.Array(Greeting) },
    },
  },
});
```

`implement(greetings, { ... })` now fails to type-check until `listGreetings` has a handler, in
which `query.limit` is a `number`, because it has a default.

## Next steps

- [Contracts](./contracts) explains every part of a contract.
- [Handlers](./handlers) covers input, results, and errors.
- [OpenAPI and the CLI](./openapi-and-cli) covers the committed document and its governance.
- The [example application](https://github.com/slime21023/hyapi/tree/main/apps/example) uses every
  feature.
