# Review 0002: Interfaces and module depth

- Status: Accepted. The decisions below are scheduled in [the roadmap](../roadmap.md) as M12.
- Date: 2026-10-10
- Scope: `main` at `6cdcef4`, after M11 ([ADR 0004](../0004-contract-structure-and-base.md)) and the
  removal of import cycles (PR #72)
- Method: scripts over the TypeScript syntax tree and `deno doc --json`: every public symbol counted
  against its uses in `docs/`, `apps/`, `tests/`, and other packages; every internal module measured
  by lines of code and exports, with every export checked for importers; then the three largest
  modules read by hand.

The review asked whether the components are lean and sturdy:

- **Narrow interfaces.** Every public interface and type is small, expressive, and necessary.
- **Deep modules.** A module hides much behind little: few exports over substantial logic.
- **Clear boundaries.** File and symbol names say what a module does and where its boundary lies,
  and no module diverges into several reasons to change.

## Verdict

| Aspect              | Assessment                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture        | Sturdy. Every granularity is a directed acyclic graph, and the component, layer, contract-boundary, and public API rules are enforced by tests. |
| `contract`          | Mostly deep and narrow since M11: most `compile/` modules export one function over 55–170 lines.                                                |
| Public interfaces   | **Too wide.** Of 111 public symbols, 48 are referenced by no document, example, test, or other package, and 12 more only by tests.              |
| Internal interfaces | Ten exports have no importer.                                                                                                                   |
| `runtime`           | **Two divergent modules**: `app.ts` (583 lines) and `pipeline.ts` (508 lines) each mix several reasons to change.                               |
| Names               | Mostly clear. `binding.ts`, `base/typebox.ts`, `cli/src/document.ts`, and the `problem` / `Problem` pair say less than they should.             |

## Findings

IDs are stable; the roadmap and later changes refer to them.

### I1. Public declaration shapes that users never name

| Entry point             | Public symbols | Referenced nowhere | Only by tests |
| ----------------------- | -------------- | ------------------ | ------------- |
| `@hyapi/core/contract`  | 43             | 19                 | 6             |
| `@hyapi/core`           | 32             | 12                 | 5             |
| `@hyapi/core/openapi`   | 5              | 1                  | 1             |
| deno, cli, openapi-diff | 12             | 5                  | 0             |
| five plugins            | 19             | 11                 | 0             |

The unreferenced symbols fall into three groups:

- **Declaration shapes** that users write only as literals in a call, from which `defineApi`,
  `defineContract`, and the scheme constructors infer the types: `ApiInfo`, `ServerSpec`, `TagSpec`,
  `OAuthFlow`, `OAuthFlows`, `SchemeSpec`, `BasicSpec`, `BasicScheme`, `BodySpec`, `StyleOverrides`,
  `ResponseValue`, `ResponseSpec`, `OperationSpec`, `NamedResponse`, `HttpMethod`, `AnyContract`,
  `Requirement`, `Implementation`, `NotImplemented`, and `JsonValue`. Exporting them lengthens the
  documentation and turns shapes into compatibility promises.
- **Names users need** to factor their code, even though nothing references them yet: callbacks they
  implement (`HealthCheck`, `EventListener`), arguments they build apart from the call
  (`ServeOptions`, `RunOptions`, the plugins' `*Options`), and results they inspect (`Context`,
  `ErrorInfo`, `StartupDiagnostic`, `StartupDiagnosticCode`, `RuleId`, `Severity`, `HealthStatus`,
  `Server`).
- **Duplicates across plugins**: `FetchHandler` in three wrapper plugins, `JwtVerifier` and
  `OidcVerifier` with one shape, and `JwtAlgorithm` and `OidcAlgorithm`.

### I2. Internal exports without importers

| Module                                  | Exports nobody imports                                            |
| --------------------------------------- | ----------------------------------------------------------------- |
| `cli/src/config.ts`                     | `DocumentConfig`, `ProjectConfig`                                 |
| `core/src/contract/compile/security.ts` | `InheritedSecurity`                                               |
| `core/src/contract/declare/schema.ts`   | `THealthReport`, `TProblem` (they must be declared, not exported) |
| `core/src/contract/model.ts`            | `NamedSchemaModel`                                                |
| `core/src/runtime/body.ts`              | `mediaTypeOf`, `BodyResult`                                       |
| `core/src/runtime/pipeline.ts`          | `PipelineSettings`                                                |
| `core/src/runtime/security.ts`          | `SecurityResult`                                                  |

### I3. `problem()` is a shallow function

`problem(value)` copies its argument and returns it; its only effect is that `title` is required in
its parameter type. It adds a public name that differs from the `Problem` schema only by case,
although the contract already checks a problem body against the `Problem` schema.

### D1. `runtime/app.ts` mixes seven reasons to change

It holds option parsing and request IDs, format registration, document endpoints, unmatched
requests, in-flight tracking (`TrackedBody`, `InFlight`), event reporting, and shutdown. ADR 0003
keeps mutable state in `app.ts`, so tracking, reporting, and shutdown stay; the stateless parts do
not need to.

### D2. `runtime/pipeline.ts` holds two halves

The request half plans an operation, reads parameters and the body, and runs the handler. The
response half, about 200 lines, applies the response policy, encodes results, and checks headers and
statuses.

### D3. `openapi-diff/src/diff.ts` is 642 lines

It is cohesive (classifying changes), but it holds `$ref` resolution, the comparison of operations,
security, parameters, bodies, responses, and the comparison of schema constraints.

### N1. Names that say less than the module does

| Name                  | Problem                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `runtime/binding.ts`  | It holds the startup checks of implementations, handlers, timeouts, verifiers, and lifecycle resources. |
| `base/typebox.ts`     | Named after TypeBox, but it also holds the general `isRecord` and `Dict`.                               |
| `cli/src/document.ts` | It holds one function, `serialize`.                                                                     |

Three `security.ts` and two `api.ts` modules are told apart by their directories (`declare/`,
`compile/`, `runtime/`); this is accepted.

## Decisions

Taken on 2026-10-10:

| Finding | Decision                                                                                                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1      | **Export rule:** a public type is exported only when users must write its name: a callback they implement, an argument they build apart from the call, or a result they inspect. The declaration shapes of I1 stop being exported. The rule is added to `AGENTS.md`. |
| I1      | **`FetchHandler`:** `@hyapi/core` exports one `FetchHandler` type; `App.fetch` and the three wrapper plugins use it, and the plugins no longer export their own.                                                                                                     |
| I1      | **Verifiers:** `jwtBearer` and `oidcBearer` declare their return type inline; `JwtVerifier` and `OidcVerifier` are no longer exported. The plugins keep their `*Options` and `*Algorithm` types and the `JWTPayload` re-export.                                      |
| I2      | Remove the ten exports, and add an architecture test: every export of an internal module is imported by another module or re-exported by a public entry point.                                                                                                       |
| I3      | Remove `problem()`. Handlers write the problem body as a literal, which the contract checks against `Problem`.                                                                                                                                                       |
| D1      | Move the stateless parts of `app.ts` to sibling L4 modules, such as `runtime/settings.ts` (options and request IDs) and `runtime/documents.ts` (document endpoints).                                                                                                 |
| D2      | Move the response half of `pipeline.ts` to `runtime/respond.ts` (L3).                                                                                                                                                                                                |
| D3      | Split `openapi-diff/src/diff.ts` by area, for example `$ref` resolution, operations, and schema constraints.                                                                                                                                                         |
| N1      | Rename `runtime/binding.ts` to `runtime/startup.ts`, move `isRecord` and `Dict` out of `base/typebox.ts`, and rename `cli/src/document.ts` to `serialize.ts`.                                                                                                        |

The public API changes (I1, I3) are breaking and target 0.3.0. The implementing change records them
as RFC 0001 amendments and updates the public API snapshot.

## Already in good shape

- The dependency graph is acyclic at every granularity, and the contract boundaries of ADR 0004
  hold.
- Most `compile/` modules, `runtime/params.ts`, `runtime/routing.ts`, and the CLI commands export
  one or two names over substantial logic.
- Generic type parameters are named and limited to carrying contract types (Review of generics, PR
  #67).
