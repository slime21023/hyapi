# Component: base

- Package entry: none
- Visibility: Core-internal

## Purpose

Hold HyAPI's thin layer over the platform: the HTTP vocabulary and the TypeBox mechanisms that the
[contract](contract.md) compiler, the [runtime](runtime.md), and the [openapi](openapi.md) emitter
share. It is layer L0 of [ADR 0003](../0003-layered-architecture.md), as decided in
[ADR 0004](../0004-contract-structure-and-base.md).

## Responsibilities

- **HTTP (`http.ts`).** `HttpMethod`, the JSON and problem media types, `isMediaType`,
  `isJsonMediaType`, `isTextMediaType`, and `reasonPhrase`.
- **TypeBox (`typebox.ts`).** Everything that knows TypeBox's internals: `isSchema`, reading and
  writing the component-name marker, `hasCodec` and `hasRefinement`, `objectSchema`, `snapshot` and
  `cloneSchema` (copies that keep TypeBox's markers), and the standard and annotation format lists.
  A TypeBox upgrade is audited here.
- **Untrusted values (`record.ts`).** `Dict` and `isRecord`, for reading declarations and options
  whose shape is not checked yet.

## Boundary

- Mechanisms only: no diagnostics, no policy, no events, and no state.
- No contract concepts. Declarations, the model, and diagnostic codes belong to
  [contract](contract.md).

## Interface

Internal functions and types, imported through relative paths by `contract`, `runtime`, and
`openapi` only. Public types defined here, such as `HttpMethod`, are re-exported by the entry point
that owns them.

## Dependencies

TypeBox only. The CLI, `serve`, and plugins cannot import it.

## Failure behavior

Pure functions; none throws for expected input.

## Related decisions

ADR 0002 §1, §3; ADR 0003 §1, §4; ADR 0004 §1.

## Open questions

- None.
