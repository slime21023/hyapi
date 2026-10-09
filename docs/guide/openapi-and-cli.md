# OpenAPI and the CLI

The OpenAPI document is what consumers in other languages receive, so HyAPI treats it as a
deliverable: emitted from the contracts, committed, reviewed in pull requests, and checked for
breaking changes.

## Configuration

The CLI reads the `hyapi` section of `deno.json`:

```json
{
  "hyapi": { "api": "./contracts/api.ts#api", "openapi": "./openapi.json" }
}
```

`--api <module#export>` and `--out <file>` override it. The document's extension chooses the format:
`.json`, `.yaml`, or `.yml`.

## `hyapi emit`

Compiles the contracts into an OpenAPI 3.1 document. The output is deterministic and stable under
`deno fmt`:

- named schemas and responses become components, referenced by `$ref`;
- each operation's effective security is written where it differs from the API root;
- parameter styles are written only where they differ from OpenAPI's defaults; and
- only the responses the contract declares are documented.

`hyapi emit --check` fails when the committed document is missing or out of date. Run it in CI.

Runtime and document come from the same interpretation of the contracts, so the document describes
exactly what the runtime enforces. To emit in code, call `emitOpenApi(api)` from
`@hyapi/core/openapi`; it throws a `ContractError` with every diagnostic when the contracts have
errors.

## `hyapi doctor`

Checks the contracts and the committed document without starting a server. It also lists the
statuses the runtime can produce that operations do not declare, such as 400 for invalid input or
503 for timeouts, so you can decide whether to document them.

## `hyapi diff`

Compares the API compiled from the current contracts with the document committed on `main`
(`origin/main` in CI checkouts):

```sh
hyapi diff                     # text; breaking changes exit with 1
hyapi diff --format markdown   # for pull request comments and release notes
hyapi diff --allow-breaking    # acknowledge intended breaking changes
```

Each change has a stable rule and a severity. The rules depend on direction: for what consumers
send, stricter is breaking; for what they receive, looser is breaking. Some examples:

| Change                               | Request      | Response     |
| ------------------------------------ | ------------ | ------------ |
| A required property is added         | breaking     | non-breaking |
| A property becomes optional          | non-breaking | breaking     |
| An enum value is added               | non-breaking | breaking     |
| A type widens (`integer` → `number`) | non-breaking | breaking     |
| A `maxLength` decreases              | breaking     | non-breaking |

Removing an operation, a 2xx response, or a media type is breaking, and so is adding security or
renaming an `operationId` (generated clients change their method names). The comparison engine is
the standalone package `@hyapi/openapi-diff`, which works on any OpenAPI 3.1 document.

## In CI

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # hyapi diff needs main
- uses: denoland/setup-deno@v2
  with:
    deno-version: v2.9.x
- run: deno task verify # includes hyapi emit --check
- run: deno task diff
```

`hyapi new` creates this workflow.

## `hyapi new`

`hyapi new <dir>` creates a project with an example contract, handlers, tests, tasks, a CI workflow,
and its first `openapi.json`.
