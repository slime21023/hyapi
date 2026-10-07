# ADR 0001: HyAPI becomes a contract-first API library

- Status: Accepted
- Date: 2026-10-07
- Scope: product identity, development workflow, public API shape, package layout, and repository
  records
- Supersedes: every record formerly under `_design/` (RFCs 0001–0008, the earlier ADR 0001, the
  v0.2–v1.0 migration notes, the roadmap, the performance baseline, and the quality rule). Those
  records remain available in git history up to commit `c52c0be`.

## Context

HyAPI `v1.0.0-rc.5` is a code-first framework. Routes are declared in TypeScript with TypeBox
schemas and projected into an OpenAPI document. Around the routes it grew Modules, Ports and Port
contract versions, Providers, a scoped service container with overrides, Guards, mutable lifecycle
hooks, typed request state, a resilience toolkit (retry, circuit breaker, bulkhead), an HTTP
contract client, and cross-service deadline propagation.

This design has three problems:

- **Two identities.** The roadmap describes a modular-monolith framework with optional service
  extraction. `AGENTS.md` describes a small, structured HTTP API framework. Core carries the
  machinery of both, and neither is complete.
- **Concept count.** About fifteen first-class concepts are needed to read the example application.
  Two dependency-injection systems (services and Ports) overlap. Most lifecycle defects found during
  the rc reviews came from the interaction between these concepts, not from HTTP handling.
- **The contract is a by-product.** Routes and handlers are written together. The OpenAPI document
  is projected from them afterwards, so the artifact that API consumers rely on is never designed,
  reviewed, or governed on its own.

No version has been published to JSR, so there is no compatibility debt. This is the cheapest moment
to replace the design rather than keep refining it.

An earlier draft of this ADR chose a document-first model in the style of Python Connexion: a
hand-written OpenAPI YAML file read at runtime. A walkthrough of the developer experience showed two
costs. Every structure is written twice, once in YAML and once in TypeScript. Type feedback also
arrives only after a separate generation or checking step. Review then established that contracts
are written by the TypeScript developers who implement them. That removes the main reason for YAML
input. The draft was replaced by the model below before it was committed.

## What contract-first means for HyAPI

"Spec-first" can promise several different things:

| Value                         | Meaning                                                       | HyAPI                       |
| ----------------------------- | ------------------------------------------------------------- | --------------------------- |
| Design before implementation  | The contract is reviewed and agreed before handlers exist     | Committed                   |
| No drift                      | The implementation cannot deviate from the contract           | Committed                   |
| Language-neutral artifact     | Consumers in any language receive a standard OpenAPI document | Committed                   |
| Evolution governance          | Breaking changes are detected, reviewed, and communicated     | Committed                   |
| Native type experience        | Instant editor feedback with no generation step               | **Signature value**         |
| Parallel development          | Consumers can integrate against mocks before implementation   | Recipe now; mock mode later |
| Externally authored contracts | The service implements an OpenAPI file written elsewhere      | Out of scope                |

Only the last value requires the contract's source format to be YAML or JSON. Every other value
requires something else: a contract that is **independent of the implementation, written before it,
reviewable, and compiled into a faithful OpenAPI document**.

## Vision and positioning

> HyAPI contracts are written in TypeScript, agreed before implementation, and compiled into OpenAPI
> 3.1 documents of delivery quality. Developers get native types; consumers in any language get a
> faithful, stable, and governed OpenAPI document.

**Authors** are the TypeScript developers who implement the API. **Consumers** are mainly external
and multi-language: partners and services that rely on the published OpenAPI document. The
**signature value** is the native type experience. **Evolution governance** is the second
differentiator.

**Prior art.** ts-rest, oRPC (contract-first mode), Effect HttpApi, and Hono with zod-openapi
already offer TypeScript contracts with typed handlers. They treat OpenAPI as a secondary output.
HyAPI treats the emitted OpenAPI document as the product that consumers receive. It must be faithful
to runtime behavior, deterministic, reviewable in pull requests, and checked for breaking changes.
HyAPI also stays Deno-first and Web-standard, and it reports every contract and implementation
mismatch at startup.

**Difference from rc.5.** rc.5 also used TypeBox, but its routes fused contract and implementation,
and its OpenAPI document was a projection. In the new design the contract is a separate, complete
declaration. The implementation is bound to it and cannot change it.

## Decision

### 1. The contract is a TypeScript module

- A contract is declared with `defineContract` as a **flat map keyed by `operationId`**. The
  `operationId` is the contract key, the handler key, and the emitted OpenAPI `operationId`.
- Each operation declares its method, path, parameters, body, responses, security requirements, and
  documentation metadata (summary, description, tags, `deprecated`).
- An application may combine several contract modules, for example one per resource. A duplicate
  `operationId` or a conflicting method and path fails startup.
- Contract modules contain no implementation. They can be reviewed, merged, and published before any
  handler exists.

### 2. Schemas are TypeBox and must be representable as JSON Schema

- Schemas are written with TypeBox. TypeBox schemas are JSON Schema, so the emitted OpenAPI document
  describes exactly what runtime validation enforces.
- A contract may use only constructs that are fully representable in JSON Schema. Transforms,
  refinements, and other code-only behavior are not allowed in contracts.
- Request and response views use **separate schemas**, for example `CreateUser` and `User`, built
  with `T.Omit`, `T.Pick`, and composition. HyAPI does not give `readOnly` or `writeOnly` special
  validation semantics.

### 3. Types are inferred, never generated

- Handler input and output types are inferred directly from the contract. Changing the contract
  immediately produces editor errors in the affected handlers, with no generation, watch, or check
  step.
- Type-checking performance is part of this promise. Contracts are expected to be split by resource,
  and type-check cost is tracked as a quality gate.

### 4. Implementation is bound by `operationId`

- `implement(contract, handlers)` binds one handler per `operationId`. The handler map is checked
  for completeness by the type checker and again at startup.
- An operation that is not implemented yet is marked explicitly with `notImplemented`. It answers
  with a 501 problem response, and startup lists every such operation. A missing or extra handler is
  an error; nothing is silently skipped.
- Dependencies are injected by closure, for example `createHandlers(deps)`. Core has no service
  container, scopes, overrides, Modules, Ports, or Providers.

### 5. Handler input and output

- **Input:** the validated and deserialized `{ params, query, headers, cookies, body }`, plus a
  context with the request `signal`, the raw `Request`, the `operationId`, and the security result.
- **Output:** `{ status, body?, headers? }`, typed as the union of the operation's declared
  responses. Core serializes the body and sets `content-type`.
- A handler may return a raw `Response` for streams or files. Core checks that its status is
  declared, but it neither buffers nor validates the raw body.
- Declared outcomes, including declared error statuses, are **returned**. `HttpError` is thrown only
  for cross-cutting or unexpected failures. Any other thrown value becomes a 500 whose details are
  hidden outside development.

### 6. Validation and response shaping

- **Requests are always validated.** Invalid input produces a 400 problem response that lists each
  violation with its location (`path`, `query`, `header`, `cookie`, or `body`) and a JSON Pointer.
- **Undeclared response fields are stripped** before serialization, so an object with extra
  properties (for example a database record) cannot leak them. In development, stripping emits a
  warning event so that the mismatch stays visible.
- **Responses are validated** by default in development. In production the policy is `off`, `log`,
  or `enforce`.
- Validation uses TypeBox. HyAPI follows TypeBox's environment detection: it compiles validators
  where dynamic code evaluation is allowed and falls back to dynamic checking where it is forbidden.
  Behavior is identical in both modes.

### 7. Parameters

- Parameters are strings on the wire. Deserialization coerces them according to their schema types
  before validation. Request bodies are never coerced.
- v1 supports path `simple`; query `form` (`explode` true or false) and `deepObject`; header
  `simple`; and cookie `form`. A contract that needs another style fails at startup.

### 8. Security is declared in the contract

- The contract declares `securitySchemes` and per-operation `security` requirements. The application
  supplies one verifier per scheme name. A verifier receives the credential that its scheme defines
  and returns an identity or rejects.
- Core evaluates the requirements: alternatives are OR, and schemes inside one requirement are AND.
  It also checks declared scopes. A missing or invalid credential produces 401 (with
  `WWW-Authenticate` for `http` schemes), and insufficient scopes produce 403.
- Security runs before parameter and body validation. A scheme without a verifier, or a verifier
  without a scheme, fails startup.

### 9. The OpenAPI document is a committed deliverable

- `hyapi emit` compiles the contracts into an OpenAPI 3.1 document. The document is committed to the
  repository, so every pull request shows its effect on what consumers receive.
- Output is deterministic. The same contracts always produce byte-identical output that is
  compatible with the repository formatter. CI runs `hyapi emit --check` to reject a document that
  is out of date.
- Reusable schemas are emitted as named components (`#/components/schemas/...`), not as anonymous
  inline types, so consumers' code generators produce meaningful names.
- `deprecated` operations and schemas are marked in the emitted document.
- Serving the document from the running service is an explicit opt-in. It is not the primary
  distribution channel.

### 10. Contract evolution is governed

- `hyapi diff` compares the current document with a baseline and classifies every change as breaking
  or non-breaking. Examples: a removed operation, a newly required field, a removed enum value, or a
  removed response field.
- CI fails on a breaking change unless the change is explicitly acknowledged, for example by a major
  version bump of the API or a recorded acknowledgement.
- The same classified diff serves two readers. Reviewers get a semantic summary on the pull request.
  Consumers get an API changelog when a version is released.

### 11. Request flow

```text
route match (404, or 405 with Allow)
  → security (401 / 403)
  → parameter deserialization and validation (400)
  → body media type, size, parsing, and validation (415 / 413 / 400)
  → handler (signal, timeout)
  → response status check, field stripping, and response validation (policy)
  → serialization → Response
```

Core never mounts a route that the contracts do not declare, apart from explicit opt-ins such as
serving the document. A health endpoint is an ordinary declared operation whose handler calls the
health aggregator.

### 12. Runtime, lifecycle, and cancellation

- Core uses only Web-standard APIs and exposes `fetch(request) => Response`. Only Deno is tested and
  guaranteed.
- A thin, Deno-specific `serve()` helper adds signal handling and graceful shutdown. It stops
  admitting requests, drains within a budget, aborts the remaining requests, and then runs shutdown
  hooks.
- Startup and shutdown hooks and health-check aggregation are kept from the previous design. Startup
  reports all contract and implementation diagnostics together.
- Each request receives one `AbortSignal` that combines client disconnect, the request timeout, and
  forced shutdown. Cross-service deadline propagation (`x-hyapi-deadline`) is removed.

### 13. Observability through read-only events

- Core emits narrow, read-only operation events. They cover operation start and end (`operationId`,
  status, duration, error), response-validation and stripping reports, and calls to deprecated
  operations.
- Event listeners cannot change requests or responses or short-circuit handling. They are not
  middleware. Logging, metrics, and tracing exporters are built on them.

### 14. Errors

Every framework-generated error is an RFC 9457 `application/problem+json` response with stable
`type` and `code` values. Development mode includes diagnostic details; production mode hides
internal details.

### 15. Packages and CLI

| Package                    | Shape                 | Responsibility                                                                                                                     |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@hyapi/core`              | library               | contracts, implementation binding, routing, deserialization, validation, security evaluation, errors, lifecycle, events, `serve()` |
| `@hyapi/cli`               | command               | `new`, `emit` (with `--check`), `diff`, `doctor`                                                                                   |
| `@hyapi/plugin-jwt`        | security verifier     | JWT verification for bearer schemes                                                                                                |
| `@hyapi/plugin-oidc`       | security verifier     | OIDC/JWKS verification for `openIdConnect` and bearer schemes                                                                      |
| `@hyapi/plugin-cors`       | outer `fetch` wrapper | CORS around `app.fetch`                                                                                                            |
| `@hyapi/plugin-csrf`       | outer `fetch` wrapper | signed double-submit CSRF protection                                                                                               |
| `@hyapi/plugin-rate-limit` | outer `fetch` wrapper | single-instance, in-memory rate limiting                                                                                           |

Core defines **no plugin interface and no middleware system**. A verifier is registered under a
security scheme name. A wrapper has the form `(fetch, options) => fetch`. Every plugin depends on
Core only through its public `mod.ts`, owns its own tests and documentation, and remains removable.

### 16. Removed

The following are deleted, not ported:

- Modules, Ports, Port contracts and versions, and Providers;
- the service container (singleton, request, and transient scopes, plus overrides);
- the Guard API (replaced by §8);
- `defineRoute`, route groups, and OpenAPI projection from routes;
- resilience policies (retry, circuit breaker, bulkhead) and the HTTP contract client;
- `defineConfig`/`AppConfig` (replaced by explicit options);
- typed request state and mutable `onRequest`/`onResponse` hooks (replaced by §13).

## Development workflow

The design is judged by the whole workflow, not only by the inner implementation loop.

```text
design        review          implement      verify            release            evolve
contract  →   contract PR  →  implement() →  tests          →  tag + publish  →   mark deprecated
+ notImpl.    + semantic      handlers       emit --check      document +         → observe usage
              diff summary                   diff              API changelog      → remove (ack'd
                                                                                    breaking change)
                 └─► consumers receive the OpenAPI document as soon as the contract PR merges
```

- **Design.** A contract change can land on its own. New operations are marked `notImplemented`, so
  the contract merges and is published before the implementation exists.
- **Review.** HyAPI does not try to enforce process: a pull request may change contract and
  implementation together. Instead, contract changes cannot go unnoticed. Every pull request carries
  the semantic diff summary, and reviewers read classified changes rather than raw JSON.
- **Implement.** Types are inferred from the contract, so the inner loop has no extra steps.
- **Verify.** CI runs tests, `hyapi emit --check`, and `hyapi diff`.
- **Release.** The emitted document is published as the versioned deliverable, together with the API
  changelog produced from the diff.
- **Evolve.** An operation is first marked `deprecated`. Its remaining usage is observed through
  operation events. It is removed only as an acknowledged breaking change.
- **Parallel development.** Until mock mode exists, consumers mock the published document with
  external tools such as Prism. A recipe documents this.

Most of this workflow lives in the CLI and in recipes, not in Core. Core supports it only through
`deprecated` metadata and read-only events.

## Non-goals

- ORM, database, cache, message queue, service discovery, or other infrastructure products.
- YAML or JSON documents as input, and implementing externally authored OpenAPI files.
- Code generation of types or handlers.
- Schema libraries other than TypeBox, and contract constructs that cannot be represented in JSON
  Schema.
- A general middleware system or a Core plugin interface.
- A default retry policy, or a global, distributed rate limiter in Core.
- Resolving handlers from strings or module paths.

## Later goals

- **Mock mode:** answer `notImplemented` operations from the contract's examples.
- **Typed client package:** a client inferred from the contract, also usable in tests with an
  injected `fetch` such as `app.fetch`.
- **One-time import:** `hyapi import` converts an existing OpenAPI document into a TypeScript
  contract for teams that migrate.
- **Optional API explorer:** serve Swagger UI or a similar viewer as an explicit opt-in.
- **Wider parameter styles and media types:** for example form and multipart request bodies.

## Open questions for follow-up RFCs

- The `hyapi diff` baseline (a previous tag, a published URL, or the main branch) and the
  acknowledgement mechanism for breaking changes.
- How schemas become named components, for example through a registry in the contract.
- Typing helpers for handlers that are defined outside the `implement` call.
- Whether contract modules need a lightweight entry point that consumers can import without the
  server runtime.
- Whether `default` values are applied to absent parameters, and which `format` values are asserted.
- The type-checking performance budget and how it is measured.

## Alternatives rejected

- **Document-first (Connexion-style YAML input).** It serves externally authored contracts, which
  HyAPI does not target. It requires either duplicated hand-written types or a code-generation step,
  and both weaken the signature type experience.
- **Hand-written types checked against a document, and ephemeral code generation.** These were
  variants of document-first. They reduce duplication or drift, but they never remove the generation
  or checking step from the inner loop.
- **Zod or Standard Schema.** They have larger ecosystems, but their JSON Schema conversion is lossy
  or varies by library, which conflicts with a faithful deliverable.
- **A self-built schema builder and validator.** It would give full control, but it duplicates
  TypeBox at a high maintenance cost.
- **`readOnly`/`writeOnly` view semantics.** They make shared schemas more concise, but they
  complicate both type inference and validation. Separate schemas are explicit and unambiguous.
- **A path-tree contract or per-resource nesting as the primary key.** These mirror OpenAPI's
  layout, but they make handler binding indirect. `operationId` keeps the contract, the handler, and
  the document aligned.
- **Producing OpenAPI only at release time or only at runtime.** Either way, reviewers could not see
  the document's changes before merging.
- **Mutable request and response hooks, or a Core plugin interface.** They are middleware in
  practice. Verifiers, outer `fetch` wrappers, and read-only events cover the existing plugins.
- **Keeping the modular-monolith layer as an optional package now.** No current use case requires
  it. It can be proposed separately later, built only on the public API.

## Consequences

- The code under `packages/`, `apps/example/`, `tests/`, `bench/`, and `scripts/`, and the user
  documentation under `docs/`, implement and describe the superseded `v1.0.0-rc.5` design. They will
  be replaced by later changes that follow this ADR. New work must not extend the superseded API.
- `v1.0.0-rc.5` will not be tagged or published. Versioning restarts with the new design.
- Applications built on rc.5 have no migration path. The concepts do not map one-to-one, and no
  release was published.
- Repository records (ADRs, RFCs, roadmap, and baselines) now live in `_adr/`. New performance and
  type-checking baselines are established once the new request path exists.
