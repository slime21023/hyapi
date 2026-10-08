# Component: contract

- Package entry: `@hyapi/core/contract`
- Visibility: public

## Purpose

Declare API contracts as TypeScript modules, infer handler types from them, and normalize one or
more contract modules into a single immutable `ContractModel`. This component is the **only place
where contracts are interpreted**. [runtime](runtime.md) and [openapi](openapi.md) consume the model
and never read raw declarations.

## Responsibilities

- **Declaration.** The API shape is defined in [RFC 0001](../rfcs/0001-contract-and-handler-api.md):
  `defineApi` (one per API: `info`, `servers`, `securitySchemes`, root `security`, and `contracts`)
  and `defineContract` (one per resource: an `operationId`-keyed map of operations). Named document
  parts are declared with `defineSchema`, `defineResponse`, and `defineSecurity`.
- **Type inference.** Helpers infer handler input, the per-operation response union, and verifier
  identity types directly from TypeBox `Static`, with no generation.
- **Normalization into `ContractModel`.** Every interpretation decision is made here, once:
  - merge contract modules into one API;
  - resolve each operation's effective security requirement, inheriting from the root;
  - apply parameter style and `explode` defaults;
  - resolve named components and the schema references to them; and
  - fix the canonical ordering used by every consumer.
- **Diagnostics.** `checkContracts` collects and reports every problem together:
  - duplicate `operationId`s across modules;
  - conflicting method and path pairs, including ambiguous templated paths;
  - path template parameters that do not match the `params` schema;
  - parameter styles outside the supported subset;
  - constructs that cannot be represented in JSON Schema, such as transforms and codecs;
  - security requirements that reference undeclared schemes or scopes; and
  - unregistered object schemas in requests or responses (warning).

## Boundary

- No runtime behavior: no HTTP I/O, routing, validation, or handler execution.
- No knowledge of handlers or verifiers. Checks that need them belong to [runtime](runtime.md).
- No file system access. Locating contract modules is the [cli](cli.md)'s job.
- No OpenAPI output. That is [openapi](openapi.md).

## Interface

- `defineContract(declaration)` returns a contract value that carries both data and types.
- `checkContracts(contracts)` returns the `ContractModel` (when there are no errors) and a list of
  diagnostics. Each diagnostic has a severity, a stable code, the `operationId` or schema it
  concerns, and a message.
- `ContractModel` is an immutable, normalized description of the whole API. It is public as a type,
  so that `runtime` and `openapi` can accept it. Its internal shape is not a compatibility promise
  for user code.
- Contract, operation, and inference helper types.

## Dependencies

TypeBox only. Never imports `runtime`, `openapi`, or `serve`.

## Failure behavior

`defineContract` does not throw for contract errors. It records the declaration, and
`checkContracts` reports all problems at once, because some conflicts appear only after modules are
merged. Callers decide what is fatal: `createApp` and `hyapi emit` stop on errors, and
`hyapi doctor` reports everything.

## Related decisions

ADR 0001 §1–§3, §7, §8; ADR 0002 §2, §5; RFC 0001.

## Open questions

- The type-checking performance budget. RFC 0001 §9 proposes targets to be confirmed by a spike.
- Whether parameter `default` values change the inferred input type.
- Whether contract modules need a lighter type-only import for consumers that never call
  `checkContracts`.
