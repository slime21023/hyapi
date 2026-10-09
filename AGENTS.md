# HyAPI development guide

HyAPI is a contract-first API library for Deno. Contracts are TypeScript (TypeBox), handlers are
type-checked against them, and they compile into an OpenAPI 3.1 document. The decisions behind this
guide are in [`_adr/`](_adr/): ADR 0001 (product), ADR 0002 (components), ADR 0003 (layers), and RFC
0001 (public API).

## Design principles

- **The contract is the single source of truth.** Handler types are inferred from it, the runtime
  enforces it, and the document is compiled from it. Contracts are interpreted once, into the
  internal `ContractModel`; nothing else reads raw declarations.
- **Lower layers own less.** Contract (L1) → mechanisms (L2) → request flow (L3) → application (L4)
  → host (L5) → plugins (L6). A module never imports a higher layer. Only `runtime/app.ts` holds
  mutable state and emits events; lower layers return results. No module keeps state at module
  scope.
- **Fail at startup, all at once.** Report every diagnostic together instead of ignoring an
  unsupported keyword, style, handler, or scheme. Security fails closed.
- **Explicit over automatic.** Options and dependencies are passed in, by closure. No global state,
  hidden defaults, or behavior that changes network or security policy on its own.
- **Web standards first.** Core uses only Web APIs and TypeBox. Deno-specific code stays in
  `@hyapi/core/deno`. No `eval` or `new Function` in HyAPI code.
- **Direct before abstract.** Write the plain implementation first. Add an interface, factory, or
  layer only for a second real implementation; delete indirection with one caller.

## Boundaries

Core (`@hyapi/core`) does only this:

- declare contracts and bind implementations by `operationId`;
- route, decode, validate, shape responses, and answer RFC 9457 problems;
- evaluate declared security through application-supplied verifiers;
- emit a deterministic OpenAPI 3.1 document; and
- handle cancellation, timeouts, lifecycle, health aggregation, and read-only events.

It never gets:

- YAML or JSON documents as input, code generation, schema libraries other than TypeBox, or
  constructs JSON Schema cannot represent;
- routes the contracts do not declare, except through explicit opt-in options;
- middleware, mutable hooks, or a plugin interface; or
- infrastructure: databases, caches, queues, retries, service discovery, or global rate limits.

TLS, compression, security headers, and global limits belong at the edge. Contract tooling belongs
in `@hyapi/cli`, and change classification belongs in `@hyapi/openapi-diff`, which depends on no
HyAPI package.

A plugin is either a **verifier** for a declared scheme, or an **outer wrapper**
`(fetch, options) => fetch`. It uses only public entry points, exposes one small factory with typed
options, and stays removable. Prefer a recipe with an existing package before a new plugin.

## Code conventions

- **One reason to change per module.** Name files in `snake_case` after what they do. Split a
  function when it mixes steps that could be tested apart.
- **Names say what, comments say why.** Every export has a doc comment. Inside functions, comment
  only intent, constraints, and non-obvious trade-offs, never what the next line does.
- **Results for expected failures, exceptions for bugs.** Return a tagged union (`{ kind: ... }`)
  for outcomes a caller handles, such as a malformed body or a denied request. Throw only for
  programmer errors and broken invariants.
- **Readonly by default.** Mark public fields `readonly`, return frozen objects, and never mutate an
  argument. Copy before changing.
- **Plain control flow.** Prefer early returns, small named helpers, and `for` loops over clever
  expressions. Avoid `any`; when unavoidable, add `deno-lint-ignore` next to it.
- **At most two levels of nesting.** When blocks (`if`, loops, `try`, `switch`) or closures nest
  three levels deep or more, simplify: return early, invert conditions, or extract a named function
  that takes what it needs as parameters instead of capturing it. An arrow function whose body is a
  single expression, or empty, does not count, and `else if` stays at its chain's level.
- **Unions before generics.** Most code needs no generics. Describe a closed set of cases with a
  string-literal union, a discriminated union, or an enum, which bounds the cases and keeps types
  small. Use a generic only to carry a type that the caller chooses and that must reach another
  place, such as a contract's operations reaching its handlers. Delete a type parameter that no
  caller uses.
- **Named type parameters.** Name every type parameter for what it holds, such as `Operations`,
  `Identity`, or `Contracts`, never a single letter, and document each parameter of a public type
  with `@typeParam`. Comment type-level tricks, such as `[K] extends [never]`, with why they are
  needed.
- **Stable identifiers.** Diagnostic codes are `kebab-case`; problem codes are
  `SCREAMING_SNAKE_CASE`. Messages start lowercase and say how to fix the problem.
- **Tests read as specifications.** Name tests as sentences about behavior. Public tests in
  `tests/*/public/` import only package entry points; tests of private modules go in `internal/`.

## Repository rules

- The public surface is the four Core entry points (`@hyapi/core/contract`, `@hyapi/core/openapi`,
  `@hyapi/core`, `@hyapi/core/deno`) and each package's `mod.ts`. `packages/core/src/` is private.
- A public API change updates RFC 0001, the component specification in `_adr/components/`, the guide
  in `docs/`, and `CHANGELOG.md` in the same change.
- Record design decisions, RFCs, reviews, and baselines in `_adr/`, numbered sequentially; user
  documentation goes in `docs/`.
- Benchmarks live in `bench/` and the example in `apps/example/`; neither defines the public API.
- Run the smallest relevant check while working, and `deno task verify` before calling a change
  done. The architecture tests enforce the component, layer, and nesting rules.
