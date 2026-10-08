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

`emitOpenApi(model, options)` returns an OpenAPI 3.1 document object. A companion function
serializes it to the canonical JSON text that is committed to the repository.

## Dependencies

[contract](contract.md) only. Never imports [runtime](runtime.md).

## Failure behavior

The `ContractModel` has already passed diagnostics. Any construct that still cannot be projected is
a HyAPI defect and throws an internal error. It is never silently omitted.

## Related decisions

ADR 0001 §9; ADR 0002 §2, §3.

## Open questions

- Whether to target OpenAPI 3.2 in addition to, or instead of, 3.1. oRPC already defaults to 3.2.
- Whether framework-generated problem responses (400, 401, 403, 413, 415, 500) are documented
  automatically or only when declared.
