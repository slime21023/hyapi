# Component specifications

These are living specifications for the components defined in
[ADR 0002](../0002-architecture-and-component-boundaries.md). Update a specification in the same
change as the code that it describes. A change that moves a responsibility from one component to
another needs a new ADR. Internal modules have no specifications; `base` is a Core-internal
component (ADR 0004) and has one because three components depend on it.

| Component                       | Package entry          | Depends on                      | Purpose                                                                          |
| ------------------------------- | ---------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| [base](base.md)                 | none (Core-internal)   | TypeBox                         | HTTP and TypeBox mechanisms shared by contract, runtime, and openapi             |
| [contract](contract.md)         | `@hyapi/core/contract` | TypeBox, base                   | Declare contracts, infer types, normalize into one `ContractModel`, and diagnose |
| [runtime](runtime.md)           | `@hyapi/core`          | contract, base                  | Turn a `ContractModel` and implementations into a running application            |
| [openapi](openapi.md)           | `@hyapi/core/openapi`  | contract, base                  | Turn a `ContractModel` into a deterministic OpenAPI 3.1 document                 |
| [serve](serve.md)               | `@hyapi/core/deno`     | `@hyapi/core`                   | Host an application on a Deno listener with graceful shutdown                    |
| [cli](cli.md)                   | `@hyapi/cli`           | contract, openapi, openapi-diff | `new`, `emit`, `diff`, and `doctor` commands                                     |
| [openapi-diff](openapi-diff.md) | `@hyapi/openapi-diff`  | none                            | Classify changes between two OpenAPI documents                                   |
| [plugins](plugins.md)           | `@hyapi/plugin-*`      | public entries                  | Security verifiers and outer `fetch` wrappers                                    |

## How the components fit together

```text
contract modules (user code)
       │
       ▼
contract: merge + normalize + diagnose ──► ContractModel ──┬──► runtime ──► app.fetch ◄── serve
                                                           │
                                                           └──► openapi ──► openapi.json (committed)
                                                                               │
                                                      baseline document ──► openapi-diff ──► report
```

The runtime and the emitted document come from the same `ContractModel`, so the document describes
what the runtime enforces.

## Specification template

Each specification has the same sections: Purpose, Responsibilities, Boundary, Interface,
Dependencies, Failure behavior, Related decisions, and Open questions. Interfaces describe concepts
and names, not final signatures.
