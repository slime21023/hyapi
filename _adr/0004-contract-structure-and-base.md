# ADR 0004: Contract structure and the base layer

- Status: Accepted
- Date: 2026-10-10
- Amends: [ADR 0002](0002-architecture-and-component-boundaries.md) §1 (components) and §3
  (dependency rules); [ADR 0003](0003-layered-architecture.md) §1 (layers) and §4 (import rules)
- Scheduled: [roadmap M11](roadmap.md#m11-contract-structure-and-base) (0.3.0)

## Context

ADR 0002 makes `contract` the only interpreter of contracts and says that the runtime and the
emitter "take only a `ContractModel` as input". ADR 0003 places `contract` at L1 and checks import
edges per component. Neither says how `contract` is organized inside, and an analysis of
`packages/core/src/contract/` at 0.2.5 (15 flat files, 2180 lines) found that its boundaries follow
files rather than readers:

1. **A wide, unchecked inner interface.** The runtime and the emitter import 32 symbols from 11 of
   the component's 14 internal modules. The architecture test allows any `runtime → contract`
   import, so the "only the model" rule of ADR 0002 §2 is not enforced.
2. **A leak from the compiler into the emitter.** `openapi/emit.ts` imports `LOCATIONS`, the style
   and `explode` defaults table, from `normalize_operation.ts` to decide whether to emit `style`.
   The emitter depends on a normalizer's private table instead of on the model.
3. **The model depends on the declarations.** `model.ts` takes `ApiInfo`, `ServerSpec`, `TagSpec`,
   and `HttpMethod` from `define.ts`, and `SchemeSpec` from `security.ts`, so a change to the
   authoring API silently changes the internal model.
4. **TypeBox internals in five files.** Knowledge of TypeBox's non-public markers (`~kind`,
   `~codec`, `~refine`, non-enumerable keys) and of the formats TypeBox checks is spread over
   `schema.ts`, `inspect.ts`, `snapshot.ts`, `runtime/validation.ts`, and `runtime/app.ts`. A
   TypeBox upgrade must audit all of them.
5. **Shared mechanisms that are not contract concepts.** `media.ts` (`isJsonMediaType`), `reason.ts`
   (`reasonPhrase`), and `cloneSchema` are HTTP and TypeBox mechanisms used by the runtime. They
   live in `contract` only because L1 was the lowest HyAPI layer.
6. **Mixed modules.** `define.ts` holds contract declarations, API declarations, and type-level path
   checks; `schema.ts` holds naming, a TypeBox guard, and the built-in schemas; `inspect.ts` holds
   `isRecord`, the format tables, and the schema walker; `check.ts` is the compiler's entry point
   under another name; `normalize_operation.ts` (555 lines) handles paths, parameters, bodies,
   responses, named responses, and the effective security requirement.
7. **Security rules in three files.** Schemes and requirements are in `normalize_security.ts`, the
   operation → contract → API inheritance and `implicit-public` in `normalize_operation.ts`, and the
   contract default in `check.ts`.
8. **Two registries for named components.** The schema inspector collects named schemas, while named
   responses are collected in a mutable map carried by `OperationContext`, and the component-name
   rule is checked in both places.

## Decision

### 1. A Core-internal base layer (L0)

A new directory, `packages/core/src/base/`, holds HyAPI's thin layer over the platform:

| Module       | Contents                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.ts`    | `HttpMethod`, `isJsonMediaType`, `isTextMediaType`, `reasonPhrase`.                                                                                                                                      |
| `typebox.ts` | Everything that knows TypeBox internals: `isSchema`, reading and writing the component-name marker, `objectSchema`, `isRecord`, `snapshot`, `cloneSchema`, and the standard and annotation format lists. |

- L0 becomes "Web APIs, TypeBox, and HyAPI's thin wrappers over them".
- `base` imports only TypeBox. `contract`, `openapi`, and `runtime` may import it.
- It has no public entry point. The CLI and plugins cannot use it; public types it defines, such as
  `HttpMethod`, are re-exported by the entry point that owns them.
- It holds mechanisms only: no diagnostics, no policy, and no state.

### 2. `contract` is organized by reader

The public entry `@hyapi/core/contract` and its exports do not change.

```text
contract/
  mod.ts              the public facade
  model.ts            the inner interface: ContractModel, the OpenAPI vocabulary it shares with
                      the declarations (ApiInfo, ServerSpec, TagSpec, SchemeSpec, OAuth flows),
                      and the parameter style defaults that replace LOCATIONS
  infer.ts            type inference from declarations
  declare/            what applications write
    api.ts            defineApi, Api, FormatChecks
    contract.ts       defineContract, Contract, OperationSpec, BodySpec, StyleOverrides
    path_types.ts     the type-level path parameter checks
    security.ts       defineSecurity, scheme constructors, Requirement
    response.ts       defineResponse
    schema.ts         defineSchema, Problem, HealthReport
  compile/            the only interpreter
    compile.ts        compileContracts and checkContracts
    api.ts            info, formats, merging contracts, route conflicts
    operation.ts      method, path, and assembling an operation
    parameters.ts     parameters and styles
    body.ts           request bodies
    responses.ts      responses and response headers
    security.ts       schemes, requirements, and the effective requirement
    components.ts     one registry for named schemas and named responses
    schema_rules.ts   the schema walk and what JSON Schema cannot represent
    diagnostics.ts    Diagnostic, DiagnosticCode, the reporter, ContractError
```

Dependencies inside `contract` point one way:

```text
model.ts      → base
declare/*     → model.ts, base
infer.ts      → declare/*
compile/*     → declare/*, model.ts, base
mod.ts        → declare/*, infer.ts, compile/compile.ts, compile/diagnostics.ts
```

The model owns the vocabulary it shares with the declarations, so the declarations depend on the
model and not the reverse. The emitter reads parameter defaults from `model.ts`.

### 3. A fixed inner interface

`runtime/` and `openapi/` may import from `contract/` only:

- `model.ts`;
- `compile/compile.ts` (`compileContracts`) and `compile/diagnostics.ts`;
- `declare/*` and `infer.ts` for types, plus the built-in schemas `Problem` and `HealthReport`.

Every other module under `compile/` is private to the compiler.

### 4. Enforcement

- The layer and import tests learn `base/` (L0) and the edges of §1–§3.
- A new architecture test rejects `runtime/` or `openapi/` imports of `contract/` modules outside
  §3, and `declare/` imports of `compile/`.
- A public API snapshot test lists every symbol of every public entry point, with its kind and type
  parameters, from `deno doc --json`, and compares the list with a committed snapshot. Changing the
  public surface then requires updating the snapshot in the same change.

### 5. No behavior change

The restructuring changes no public API, diagnostic code, diagnostic message, or runtime behavior.
The emitted documents stay byte-identical, which `emit --check` on the example proves.

## Consequences

- The implementing change updates ADR 0002 §1 and §3 (the components table and the dependency
  rules), ADR 0003 §1, §3, and §4 (the layer diagram, the module table, and the import rules),
  `components/contract.md`, a new `components/base.md`, and `AGENTS.md`.
- The work is one pull request, so that a single `deno task verify`, together with the public API
  snapshot and `emit --check`, shows that nothing observable changed.
- The roadmap schedules it as M11, for 0.3.0.

## Alternatives rejected

- **Fixing the boundaries but keeping files flat.** It would fix findings 2–8, but the two halves of
  the component, declarations for applications and the compiler for Core, have different readers and
  reasons to change. Directories make that boundary checkable in the same way that `layers.ts`
  checks layers by directory.
- **Keeping `http.ts` and `typebox.ts` in `contract`.** The smaller change, but `contract` would
  stay the place for anything the runtime and the compiler share, and the runtime would keep
  depending on `contract` for things that are not contracts.
- **A public `@hyapi/core/base` entry point.** Plugins could share media-type helpers, but it would
  add a fifth entry point to the four of ADR 0002 §4 and turn internal mechanisms into compatibility
  promises. Plugins already render problems through `problemResponse`.
- **Moving diagnostics into `base`.** Diagnostic codes are contract rules; the runtime's startup
  diagnostics extend them. Keeping them in `compile/` keeps `base` free of policy.
- **Several pull requests.** Smaller diffs, but the moves depend on each other, and each
  intermediate state would need its own boundary rules.
