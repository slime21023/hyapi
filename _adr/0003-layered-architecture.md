# ADR 0003: Layered architecture

- Status: Accepted
- Date: 2026-10-09
- Amends: [ADR 0002](0002-architecture-and-component-boundaries.md) §1 (runtime internals), §2 (the
  model's visibility), and §4 (public surface)
- Basis: [Review 0001](reviews/0001-component-and-production-readiness.md)

## Context

ADR 0002 fixed the components and the import edges between them, and left the runtime's internal
modules free to "be split, merged, or rewritten freely". Review 0001 showed what that freedom
produced. The lowest layers were not the simplest:

- contract checking read TypeBox's process-global `Format` registry (A1);
- health draining lived in a module-level `WeakSet` (A2);
- the "immutable" `ContractModel` aliased the application's schemas (A3);
- the security evaluator rendered HTTP responses (A8), the request flow emitted events, and the
  application re-parsed the flow's output to learn what had happened (A7); and
- `ContractModel` was exported publicly while documented as not being a compatibility promise (A9).

None of these is large. Together they show that a rule nobody enforces does not hold. This ADR
defines the layers, what each may own, how each fails, and how the rules are checked.

## Decision

### 1. Layers

The lower a layer, the less it may own and decide.

```text
L6  Extensions   plugins: outer fetch wrappers and verifiers
L5  Host         deno/serve: listener, signals, shutdown order
L4  Application  app: the only owner of mutable state; emits events
L3  Request flow pipeline: one request through the mechanisms; response policy
L2  Mechanisms   routing · params · body · validation · security · problem · deadline
                 health · lifecycle · handler types · openapi/emit
L1  Contract     declarations → checkContracts → ContractModel (internal)
L0  Platform     Web APIs and TypeBox

Tools beside the stack: cli (uses public entries), openapi-diff (uses no HyAPI package)
```

ADR 0002's components map onto the layers: `contract` is L1; `runtime` spans L2–L4; `openapi` is an
L2 consumer of the model; `serve` is L5; plugins are L6.

### 2. Rules per layer

| Layer           | Mutable state                                                                                                                                   | Interface                                                                                                                | Failure                                                                                             | Must not                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| L1 Contract     | None. The model is deep-frozen and owns copies of every schema and metadata object.                                                             | Value constructors (`define*`) and one normalizer.                                                                       | Returns diagnostics; throws only on programmer errors.                                              | Read global state; import L2 or above.                                                                |
| L2 Mechanisms   | None, or an object compiled once and immutable afterwards (route table, validators).                                                            | Small functions over model parts; cancellation through an explicit `AbortSignal`.                                        | Expected failures (malformed, too large, denied, timed out) are returned as values.                 | Emit events, log, keep timers past a call, choose an HTTP status for a situation, import L3 or above. |
| L3 Request flow | Per request only.                                                                                                                               | `execute(request) → Outcome`; the outcome carries the facts: operation, status, problem code, error, denial, violations. | Turns mechanism results into problem responses; contains handler errors.                            | Emit events, count requests, read application state other than its arguments.                         |
| L4 Application  | The only owner: phase (`running`, `closing`, `closed`), in-flight requests including open response bodies, lifecycle resources, event listener. | `createApp`, `app.fetch`, `app.close`.                                                                                   | Collects startup errors together; contains listener and resource failures; aggregates close errors. | —                                                                                                     |
| L5 Host         | Listener and signal registrations, removed on shutdown.                                                                                         | `serve`.                                                                                                                 | Never leaves a rejected promise unhandled.                                                          | Inspect requests or application internals.                                                            |
| L6 Extensions   | Their own, created by their factory.                                                                                                            | `(fetch, options) => fetch` or a verifier.                                                                               | Their own problem responses through `problemResponse`.                                              | Import anything but public entry points.                                                              |

Within L2, problem **formatting** (`problem`, `problemResponse`) is a mechanism: it renders a given
status and code. Deciding which status a situation gets is L3 policy.

### 3. Runtime modules

| Layer | Module          | Responsibility                                                                               |
| ----- | --------------- | -------------------------------------------------------------------------------------------- |
| L2    | `deadline.ts`   | Race a promise against a deadline, clearing its timer.                                       |
| L2    | `routing.ts`    | Compile the route table; match a method and path.                                            |
| L2    | `params.ts`     | Decode path, query, header, and cookie parameters (from `wire.ts`).                          |
| L2    | `body.ts`       | Media types, size-limited and cancellable reading, decoding, and encoding (from `wire.ts`).  |
| L2    | `validation.ts` | Compile validators from model schemas; check, convert, and clean values.                     |
| L2    | `security.ts`   | Evaluate requirements; return granted, denied (status, reason, challenge), or failed.        |
| L2    | `problem.ts`    | Problem values, `HttpError`, and problem responses.                                          |
| L2    | `health.ts`     | Run checks with deadlines and aggregate a report.                                            |
| L2    | `lifecycle.ts`  | Start and stop resources in order; return failures instead of emitting them.                 |
| L2    | `handler.ts`    | Handler, context, and implementation types; `implement`.                                     |
| L3    | `pipeline.ts`   | The request flow and response policy; returns an `Outcome`.                                  |
| L4    | `events.ts`     | Event types and the listener wrapper that contains listener errors.                          |
| L4    | `app.ts`        | Assembly, startup diagnostics, phases, in-flight tracking, close; the only caller of `emit`. |

Modules may still be split or renamed, but a module keeps its layer, and the table is updated in the
same change.

### 4. Import rules

- L1 imports only TypeBox.
- L2 imports L1 and other L2 modules. `openapi/` imports only L1.
- L3 imports L1 and L2.
- L4 imports L1–L3. Only L4 imports `events.ts`.
- L5 and L6 import only public entry points.

The architecture test checks these edges for `packages/core/src/`, as it already checks the edges of
ADR 0002 §3.

### 5. No module-level mutable state

No module in `packages/core/src/` declares mutable state at module scope: no top-level `let` or
`var`, and no top-level `Map`, `Set`, `WeakMap`, `WeakSet`, or array that is mutated. A test checks
this.

The one exception is TypeBox's validator, which reads custom formats from its global registry. Only
`createApp` (L4) registers formats there, from the declarations in §6. Registering a name that is
already registered with a different check is a startup error, so two applications in one process
cannot silently change each other's validation.

### 6. Custom formats are declared on the API

```ts
export const api = defineApi({
  info: { title: "Library", version: "1.0.0" },
  formats: { isbn: (value) => isIsbn(value) },
  contracts: [books],
});
```

Contract checking accepts the standard formats that TypeBox implements (`date-time`, `date`, `time`,
`duration`, `email`, `idn-email`, `hostname`, `idn-hostname`, `ipv4`, `ipv6`, `uri`,
`uri-reference`, `iri`, `iri-reference`, `uri-template`, `url`, `uuid`, `json-pointer`,
`json-pointer-uri-fragment`, `relative-json-pointer`, `regex`) and the names in `formats`. Anything
else is the `unknown-format` diagnostic. The result no longer depends on what else ran in the
process, so `checkContracts`, `createApp`, and `hyapi emit` always agree.

### 7. `ContractModel` is internal

The model remains the single interpretation of ADR 0002 §2, shared by the runtime and the emitter
inside `@hyapi/core`. It is no longer exported.

- `checkContracts(api)` returns `{ ok, diagnostics }`.
- `emitOpenApi(api)` takes the API definition. It normalizes the contracts itself and throws a
  `ContractError` carrying every diagnostic when they have errors.
- The CLI uses `checkContracts`, `emitOpenApi`, and the emitted document. `doctor` reads operations
  and responses from the document.
- A typed client infers from contract types or reads the document; neither needs the model.

The model's structure can then change without a breaking release.

### 8. Health has no draining state

When `close()` begins, every new request is answered with 503 `SHUTTING_DOWN`, including the health
operation, so load balancers already see the instance leave. A draining flag inside the health
report was redundant, and it required the global state of A2.

`createHealth` becomes a pure aggregator; `HealthReport` loses `draining`; `markDraining` is
deleted; `createApp` no longer takes `health`. Applications that need readiness to fail some time
before draining starts implement that delay in their host code before calling `shutdown()`.

### 9. Facts flow up, events are emitted once

Mechanisms return results, the request flow returns an `Outcome`, and lifecycle returns failures.
Only the application turns them into events. The outcome carries everything an event needs (problem
code, denial reason, violations, stripped fields), so no layer re-parses another layer's output.

## Consequences

- **Public API changes** (pre-1.0, recorded as RFC 0001 amendments in the implementing change):
  - `defineApi` gains `formats`;
  - `checkContracts` returns `{ ok, diagnostics }`, and the model types are no longer exported;
  - `emitOpenApi` takes the API definition and throws `ContractError`;
  - `HealthReport` drops `draining`, and `createApp` drops `health`.
- **Tests:** the architecture test gains the layer edges of §4 and the state rule of §5; internal
  tests cover L2 modules directly (Review 0001 A10).
- **Specifications:** `components/runtime.md` lists the modules of §3 instead of saying they are
  unconstrained; `components/contract.md` and `components/openapi.md` describe the new public
  surface.
- **Roadmap:** restructuring to these layers is milestone M8, before the correctness fixes (M9) and
  the production features (M10), so that each fix lands in the layer that owns it.

## Alternatives rejected

- **Guidelines without enforcement.** ADR 0002 already said "policy-free"; Review 0001 found policy
  and state in low layers anyway.
- **One specified component per runtime module.** Rejected again for the reasons in ADR 0002: each
  would have one caller and its own document. The module table in §3 is enough.
- **Formats in `createApp` options and CLI configuration.** The contract would name formats that
  only the application can check, so the CLI and the runtime could disagree again.
- **Keeping the global registry, snapshotted at startup.** Global state remains, and the order of
  imports still matters.
- **Draining as an explicit input to health, or a host-level drain delay.** Both keep a concept that
  the 503 of a closing application already covers.
- **A public, versioned `ContractModel`.** Useful to external tools, but it freezes a large internal
  structure. The emitted document is already the stable, standard interface for tools.
