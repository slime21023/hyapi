# ADR 0002: Architecture and component boundaries

- Status: Accepted; §1, §2, and §4 amended by [ADR 0003](0003-layered-architecture.md); §1 and §3
  amended by [ADR 0004](0004-contract-structure-and-base.md)
- Date: 2026-10-08
- Scope: components, dependency rules, package entry points, public surface, and component
  specifications for the design in [ADR 0001](0001-contract-first-api-library.md)

## Context

ADR 0001 fixes what HyAPI is. It does not fix how the code is divided. rc.5 grew one large `app.ts`
and a request pipeline that mixed routing, decoding, validation, authorization, lifecycle, and
cleanup. Its public facade also exported low-level pieces that became compatibility promises.

The new design has consumers that must not load the server runtime. The CLI compiles contracts into
OpenAPI. A future typed client infers types from contracts. Teams may publish contract modules to
other TypeScript projects.

The new design also promises that the emitted OpenAPI document is faithful to runtime behavior. That
promise is fragile if the document generator and the runtime each interpret contracts on their own.

No code exists yet, so components should be few, and their boundaries should protect only what
matters: the public surface, the separation of contract consumers from the runtime, and a single
interpretation of contracts.

## Decision

### 1. Three core components

```text
                ┌──────────────────────────────────────────┐
                │ contract                                 │
                │  declaration · type inference            │
                │  merge + normalization → ContractModel   │
                │  diagnostics                             │
                └─────────────┬───────────────┬────────────┘
                              ▼               ▼
                       ┌────────────┐   ┌────────────┐
                       │  runtime   │   │  openapi   │
                       └─────┬──────┘   └────────────┘
                             ▼
                          serve (host)

 around the core: cli · openapi-diff · plugins
```

| Component                                  | Package entry          | Responsibility                                                                   |
| ------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------- |
| [contract](components/contract.md)         | `@hyapi/core/contract` | Declare contracts, infer types, normalize into one `ContractModel`, and diagnose |
| [runtime](components/runtime.md)           | `@hyapi/core`          | Turn a `ContractModel` and implementations into a running application            |
| [openapi](components/openapi.md)           | `@hyapi/core/openapi`  | Turn a `ContractModel` into a deterministic OpenAPI 3.1 document                 |
| [serve](components/serve.md)               | `@hyapi/core/deno`     | Host an application on a Deno listener with graceful shutdown                    |
| [cli](components/cli.md)                   | `@hyapi/cli`           | `new`, `emit`, `diff`, and `doctor` commands                                     |
| [openapi-diff](components/openapi-diff.md) | `@hyapi/openapi-diff`  | Classify changes between two OpenAPI documents                                   |
| [plugins](components/plugins.md)           | `@hyapi/plugin-*`      | Security verifiers and outer `fetch` wrappers                                    |
| [base](components/base.md)                 | none (Core-internal)   | HTTP and TypeBox mechanisms shared by `contract`, `runtime`, and `openapi`       |

The runtime is **one component**. Routing, parameter and body decoding, validation, security
evaluation, problem responses, the request flow, events, lifecycle, and health are internal modules
of `runtime`. They have no specifications of their own and can be split, merged, or rewritten
freely.

### 2. One interpretation of contracts: `ContractModel`

Normalization happens once, in `contract`. It merges contract modules, resolves the security
requirement inherited from the contract root, applies parameter style defaults, registers named
components, and detects conflicts. Its output is an immutable `ContractModel`.

`runtime` and `openapi` take only a `ContractModel` as input. Neither may read raw contract
declarations or re-derive anything that normalization decides. Runtime behavior and the emitted
document therefore come from the same interpretation, so the document's faithfulness is guaranteed
by the structure, not only by tests.

### 3. Dependency rules

- `base` depends only on TypeBox, and only `contract`, `runtime`, and `openapi` may import it (ADR
  0004 §1).
- `contract` depends only on TypeBox and `base`. It never imports `runtime`, `openapi`, or `serve`.
- `runtime` and `openapi` depend on `contract` and never on each other. They import from `contract`
  only its model, the compiler's entry point and diagnostics, and the declaration types (ADR 0004
  §3). The runtime's opt-in document endpoint receives an already emitted document from the
  application, so `runtime` needs no import of `openapi`.
- `serve` depends only on the public `@hyapi/core` entry and Deno APIs.
- `openapi-diff` depends on no HyAPI package. It works on any OpenAPI document.
- `cli` and every plugin depend only on public entry points, never on `src/`.

An architecture test enforces these import edges.

### 4. One core package, four public entry points

`@hyapi/core` stays a single package with one version and four entry points: `@hyapi/core/contract`,
`@hyapi/core/openapi`, `@hyapi/core`, and `@hyapi/core/deno`.

- JSR loads modules individually. A consumer that imports `@hyapi/core/contract` never loads the
  runtime.
- The main entry stays Web-standard. Deno-specific code is reachable only through
  `@hyapi/core/deno`.
- The runtime's public surface is its assembly API: `createApp`, `implement`, `notImplemented`,
  `HttpError`, options, and the types that handlers, verifiers, and event listeners need. Nothing
  internal to the runtime is exported.

`@hyapi/openapi-diff` is a separate package because it does not depend on HyAPI at all. This adds a
package to the list in ADR 0001 §15.

### 5. Diagnostics run once, everywhere

Contract diagnostics are part of normalization and are exposed as `checkContracts`. The same rules
run in `createApp`, `hyapi emit`, and `hyapi doctor`, and all three produce identical messages. A
contract-only pull request can therefore be fully checked before any handler exists. Diagnostics
that need implementations (handlers and verifiers) run only in `createApp`. Diagnostics are
collected and reported together.

### 6. Component specifications

Each component in §1 has one living specification under [`components/`](components/README.md). Each
specification records the component's purpose, responsibilities, boundary, interface, dependencies,
failure behavior, and open questions. Internal modules have no specifications; code and tests
document them.

ADRs remain immutable decision records. A component specification is updated in the same change as
the code that it describes. A change that moves a responsibility between components needs a new ADR.

## Alternatives rejected

- **Twelve components with seven private runtime components.** This divided the runtime by technical
  concern (routing, wire, validation, security, problem, pipeline, app) before any code existed.
  Each private component had one caller and its own specification. Every boundary was a guess, and
  the documentation cost came before the code.
- **A separate compiler and plan, with an independent executor.** This separates startup work from
  request work cleanly. It adds two components and a core data structure that three components must
  agree on. Placing normalization in `contract` keeps the single interpretation with fewer moving
  parts.
- **Letting `openapi` read raw contracts.** It is simpler to build, but the document and the runtime
  could interpret the same contract differently, which undermines HyAPI's main promise.
- **`diff` inside `@hyapi/cli`.** It needs no HyAPI code. A standalone package serves any OpenAPI
  project and keeps the CLI thin.
- **A separate `@hyapi/contract` package, or a single `mod.ts` entry.** See §4. Separate packages
  would need locked versions. A single entry would load the Deno-specific `serve` for every
  consumer.

## Consequences

- `AGENTS.md` names the four entry points as the public Core boundary.
- Public contract tests import only public entry points. Internal tests may import runtime modules
  directly.
- The source tree follows the components: `packages/core/src/base/`, `packages/core/src/contract/`,
  `packages/core/src/runtime/`, `packages/core/src/openapi/`, `packages/core/src/deno/`,
  `packages/cli/`, and `packages/openapi-diff/`.
- An architecture test enforces §3.
