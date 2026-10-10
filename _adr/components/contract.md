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
  and `defineContract` (one per resource: an `operationId`-keyed map of operations, default `tags`,
  and a default `security`). Named document parts are declared with `defineSchema`,
  `defineResponse`, and `defineSecurity`.
- **Component names.** `defineSchema` stores the name under a non-enumerable string key, like
  TypeBox's own `~kind` markers. TypeBox keeps such keys when it derives schemas, so schemas nested
  in `T.Omit` or `T.Partial` results keep their names, while the derived top-level schema does not
  inherit one. Problem responses are recognized by the component name `Problem`.
- **Scheme types.** `Scheme<Identity>` carries, in types only, the identity the scheme's verifier
  returns. The credential the verifier receives follows from the scheme's `spec`: `httpBasic`
  returns a `BasicScheme`, whose credential is a `BasicCredential` (`{ username, password }`); every
  other scheme receives a string.
- **Type inference.** Helpers infer handler input, the per-operation response union, and verifier
  identity types directly from TypeBox `Static`, with no generation.
- **Normalization into `ContractModel`.** Every interpretation decision is made here, once:
  - merge contract modules into one API;
  - resolve each operation's effective security requirement (operation, then contract default, then
    API root);
  - apply parameter style and `explode` defaults;
  - resolve named components and the schema references to them; and
  - fix the canonical ordering used by every consumer.
- **Diagnostics.** `checkContracts(api)` collects and reports every problem together, with a stable
  `code` per rule (see `DiagnosticCode`). The rules include:
  - duplicate `operationId`s across modules;
  - conflicting method and path pairs, including ambiguous templated paths;
  - path template parameters that do not match the `params` schema;
  - parameter styles outside the supported subset;
  - constructs that cannot be represented in JSON Schema, such as transforms and codecs;
  - `format` values that neither TypeBox nor OpenAPI's registry recognizes;
  - security requirements that reference undeclared schemes or scopes; and
  - unregistered object schemas in requests or responses (warning).

## Structure

The component is organized by reader ([ADR 0004](../0004-contract-structure-and-base.md)):

| Part       | Reader                      | Contents                                                                                                                                                                                                                     |
| ---------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declare/` | applications                | `defineApi`, `defineContract` and the type-level path checks, `defineSecurity` and scheme constructors, `defineResponse`, `defineSchema`, `Problem`, `HealthReport`                                                          |
| `infer.ts` | handlers and verifiers      | `InputOf`, `ResultOf`, and the security result types                                                                                                                                                                         |
| `model.ts` | the runtime and the emitter | `ContractModel`, the OpenAPI vocabulary it shares with the declarations (`ApiInfo`, `ServerSpec`, `TagSpec`, `SchemeSpec`, OAuth flows), and `PARAMETER_DEFAULTS`                                                            |
| `compile/` | Core only                   | `compile.ts` (`compileContracts`, `checkContracts`), `api.ts`, `operation.ts`, `parameters.ts`, `body.ts`, `responses.ts`, `security.ts`, `components.ts` (named schemas and responses), `schema_rules.ts`, `diagnostics.ts` |

Dependencies point one way: `model.ts` imports only [base](base.md); `declare/` imports `model.ts`
and base; `infer.ts` imports `declare/`; `compile/` imports all of them. The runtime and the emitter
import only `model.ts`, `compile/compile.ts`, `compile/diagnostics.ts`, the built-in schemas, and
the types of `declare/` and `infer.ts`. The architecture test `tests/architecture/contract.ts`
enforces these edges.

## Boundary

- No runtime behavior: no HTTP I/O, routing, validation, or handler execution.
- No knowledge of handlers or verifiers. Checks that need them belong to [runtime](runtime.md).
- No file system access. Locating contract modules is the [cli](cli.md)'s job.
- No OpenAPI output. That is [openapi](openapi.md).

## Interface

- `defineContract(declaration)` returns a contract value that carries both data and types.
- `defineApi({ info, formats?, securitySchemes?, security?, contracts })` declares the API,
  including checks for custom `format` values.
- `checkContracts(api)` returns `{ ok, diagnostics }`. Each diagnostic has a severity, a stable
  code, the `operationId` or location it concerns, and a message.
- `ContractError` carries the diagnostics when `emitOpenApi` is given contracts with errors.
- Contract, operation, and inference helper types.

`ContractModel` is internal to `@hyapi/core` (ADR 0003 §7). The runtime and the emitter receive it
from the internal `compileContracts`; applications and tools never see it.

## Dependencies

TypeBox and [base](base.md). Never imports `runtime`, `openapi`, or `serve`.

## Failure behavior

`defineContract` does not throw for contract errors. It records the declaration, and
`checkContracts` reports all problems at once, because some conflicts appear only after modules are
merged. Callers decide what is fatal: `createApp` and `hyapi emit` stop on errors, and
`hyapi doctor` reports everything.

## Related decisions

ADR 0001 §1–§3, §7, §8; ADR 0002 §2, §5; RFC 0001.

## Resolved questions

- Type-checking budget: the RFC 0001 §9 targets hold for the real implementation. See the
  [type-performance baseline](../baselines/type-performance.md).
- Parameter defaults are applied by the runtime, and are required in input types when declared with
  `T.With` (RFC 0001 amendment A2).
- No separate type-only entry point. `@hyapi/core/contract` depends only on TypeBox.

## Resolved in M8

- **Layer L1 (ADR 0003).** Normalization is split into pure steps that report to an explicit
  collector: `inspect.ts` (schema inspection and named schemas), `normalize_security.ts`,
  `normalize_operation.ts` (parameters, body, responses), and `check.ts`, which composes them.
- **Frozen copy.** The model is a deep, frozen copy of the declarations (`snapshot.ts`). Shared
  schemas stay shared, and TypeBox's non-enumerable markers are kept. Later changes to the
  declarations cannot reach the model.
- **Formats.** Accepted formats are TypeBox's standard formats, OpenAPI's annotation formats, and
  the names in `defineApi({ formats })` (RFC 0001 A16). The result never depends on TypeBox's
  process-wide registry. Redeclaring a standard format is `invalid-format`.

## Resolved in M9

- **Fail closed.** `implicit-public` is an error when the API declares security schemes and an
  operation has no requirement at any level (RFC 0001 A23).
- **Byte bodies.** `unsupported-body-schema` is an error when a request body that is neither JSON
  nor text has a schema other than a binary string (A24). The media-type classification lives in
  `media.ts`, and the runtime uses the same functions.
- **Reserved name.** `reserved-schema-name` is an error when a schema other than the built-in
  `Problem` is named `Problem` (A25).

## Resolved in M11

- **Structure (ADR 0004).** `define.ts`, `security.ts`, `response.ts`, and `schema.ts` became
  `declare/`; `check.ts`, `inspect.ts`, `normalize_operation.ts`, `normalize_security.ts`, and
  `diagnostics.ts` became `compile/`, with operations split into operation, parameters, body, and
  responses. The security rules, including the effective requirement, are in `compile/security.ts`,
  and named schemas and responses share one registry in `compile/components.ts`.
- **Base.** `media.ts`, `reason.ts`, `snapshot.ts`, the schema guard, the name marker, and the
  format lists moved to [base](base.md). The emitter reads `PARAMETER_DEFAULTS` from the model
  instead of a normalizer's private table.

## Open questions

- None. Future questions are tracked in the [roadmap](../roadmap.md).
