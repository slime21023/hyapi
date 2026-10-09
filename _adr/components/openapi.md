# Component: openapi

- Package entry: `@hyapi/core/openapi`
- Visibility: public

## Purpose

Turn a `ContractModel` into the OpenAPI 3.1 document that consumers receive. The emitted document is
the product HyAPI delivers, so it must be faithful, deterministic, and stable.

## Responsibilities

- Map every operation, parameter, body, response, security requirement, and metadata field in the
  `ContractModel` to OpenAPI 3.1.
- Emit named components as `#/components/schemas/<name>` and reference them with `$ref`.
- Mark `deprecated` operations and schemas.
- Produce deterministic output: the same model always yields byte-identical JSON. Ordering comes
  from the `ContractModel`, and the formatting matches the repository formatter.
- Describe the problem+json responses that the runtime can produce, as far as the contract opts in
  to documenting them.

## Boundary

- Reads only the `ContractModel`. It never reads raw contract declarations or makes interpretation
  decisions of its own. Every interpretation belongs to [contract](contract.md).
- No file writing, comparison, or `--check`. Those belong to [cli](cli.md).
- No HTTP endpoint. An application can pass an emitted document to [runtime](runtime.md) for opt-in
  serving.
- No YAML or JSON documents as input.

## Interface

`emitOpenApi(api)` normalizes the API's contracts with the internal `compileContracts` and returns
an OpenAPI 3.1 document object (`openapi: "3.1.1"`). `serializeOpenApi(document)` returns the
canonical JSON text: two-space indentation, LF line endings, and a final newline, which `deno fmt`
leaves unchanged. YAML serialization lives in the CLI.

## Dependencies

[contract](contract.md) only. Never imports [runtime](runtime.md).

## Failure behavior

Contracts with errors throw `ContractError` with every diagnostic, so `emitOpenApi` never emits a
partial document. Any construct that passed diagnostics and still cannot be projected is a HyAPI
defect and throws an internal error. It is never silently omitted.

Parameter `style` and `explode` are emitted only when they differ from OpenAPI's defaults for the
location, which the emitter reads from the contract component instead of keeping its own table.

## Related decisions

ADR 0001 §9; ADR 0002 §2, §3.

## Resolved in M3

- **Version.** HyAPI emits OpenAPI 3.1 only, because 3.1 has the widest code-generator support among
  consumers. 3.2 can be added when the tooling ecosystem follows.
- **Framework responses.** Only responses that the contract declares are emitted. `hyapi doctor`
  lists the framework statuses (400, 413, 415, 500, 503) that each operation can produce but does
  not declare.
- **Security on operations.** The API root requirement is inherited in OpenAPI and is not repeated.
  Contract defaults have no OpenAPI equivalent, so they are written on each operation.
- **Parameters.** `style` and `explode` are written only when they differ from OpenAPI's default for
  the location. A property schema's `description` and `deprecated` are also written on the
  parameter.
- **Named schemas.** A schema named with `defineSchema` becomes a `$ref` wherever it appears,
  including inside schemas derived with `T.Omit` or `T.Partial` (see the contract specification).

## Open questions

- None for v1.
