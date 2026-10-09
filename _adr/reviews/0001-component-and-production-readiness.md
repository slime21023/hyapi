# Review 0001: Component design and production readiness

- Status: Accepted. Findings are scheduled in [the roadmap](../roadmap.md) as M8–M10.
- Date: 2026-10-09
- Scope: `docs/contract-first-redesign` at `ad13a9a` (0.1.0 candidate, PR #53)
- Method: two independent read-only reviews, each confirmed by probe scripts run against the public
  entry points; the high-severity findings were re-checked against the code.

The review asked two questions:

1. **Components.** The lower a component sits in the dependency stack, the simpler and more
   controllable it must be: a small, stable interface; explicit state with one owner; no hidden
   global state; predictable failures; testable in isolation.
2. **Features.** Is the design usable in production? In particular: can applications use CORS
   correctly, implement their own authentication and role-based access control (RBAC), and serve
   more than one OpenAPI document?

## Verdict

**Components.** The layering is sound. The import rules of ADR 0002 are enforced by a test, and
`routing`, `deadline`, `lifecycle`, and `validation` are small, pure, or closure-scoped. Four places
break the principle: two pieces of process-global state, a contract model that is not actually
immutable, and an unhandled rejection in `serve`.

**Production.** Ready with caveats. Buffered JSON APIs behind a reverse proxy work. Before 1.0, one
validation hole, a fail-open security default, and streaming shutdown must be fixed. CORS and RBAC
work today with documented limits; serving several documents needs new API.

CI has run once since the review started: PR #53 passed on Linux, including the signal-shutdown
test.

## Component findings

IDs are stable; the roadmap and later changes refer to them.

| ID  | Severity | Finding                                                                                                                                                                                                                                      | Evidence                                                                        | Recommendation                                                                                                                                              | Public API                                   |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| A1  | High     | Contract checking reads TypeBox's global `Format` registry. The same contract passes or fails depending on what else ran first, so `createApp` and `hyapi emit` (which loads only the contract module) can disagree, breaking ADR 0002 §5.   | `contract/check.ts:257`; probe: `ok: false`, then `ok: true` after `Format.Set` | Declare custom formats explicitly, for example `defineApi({ formats })`; check against that map and register formats only from `createApp`.                 | Changes                                      |
| A2  | High     | Health draining is stored in a module-level `WeakSet`. It is process-global and cannot be reset: one health aggregator shared by two apps reports `unhealthy` for both when one closes. A hand-written `Health` is never marked.             | `runtime/health.ts:28`; `runtime/app.ts:396`; probe                             | Make draining an explicit input, for example `createHealth(checks, { draining })`, and delete `markDraining`.                                               | Changes                                      |
| A3  | High     | `ContractModel` aliases the application's schema objects and `info`. Mutating a schema after startup changes the emitted document but not the compiled validators, so document and runtime disagree.                                         | `contract/check.ts:633,807,882,890`; probe: `Object.isFrozen` is false          | Deep-clone (keeping TypeBox's hidden markers) and deep-freeze schemas and metadata during normalization. Move `cloneSchema` from the runtime to `contract`. | No                                           |
| A4  | High     | `serve().finished` rejects with no handler when a lifecycle resource fails to stop. The process crashes even when the caller caught `shutdown()`.                                                                                            | `deno/serve.ts:100-103`; probe: uncaught `AggregateError`                       | Handle the rejection internally; report close errors only through `shutdown()`.                                                                             | No                                           |
| A5  | Medium   | Response headers are checked for presence only, not against their schemas. `responseValidation: "off"` still emits `response.violation` for missing headers, and undeclared statuses are rejected only under `enforce`, unlike `runtime.md`. | `runtime/pipeline.ts:254,294,312-320`; probe                                    | Validate header values with prepared validators; gate every response check behind the policy; align the specification.                                      | No                                           |
| A6  | Medium   | `checkContracts` is one function of about 710 lines whose closures share mutable state.                                                                                                                                                      | `contract/check.ts:182-894`                                                     | Split into pure helpers (`inspectSchema`, `normalizeSecurity`, `normalizeOperation`, `normalizeResponse`) with an explicit report sink.                     | No                                           |
| A7  | Medium   | `app.ts` re-parses its own problem responses to recover `code`, which the pipeline already knew.                                                                                                                                             | `runtime/app.ts:353-355`                                                        | Add `code` to the pipeline's `Outcome`.                                                                                                                     | No                                           |
| A8  | Medium   | The security evaluator builds HTTP responses and `WWW-Authenticate` headers.                                                                                                                                                                 | `runtime/security.ts:182-206`                                                   | Return a denial (`status`, `challenge`) and let the pipeline render it.                                                                                     | No                                           |
| A9  | Medium   | `ContractModel` is exported publicly but documented as not being a compatibility promise; the CLI depends on it.                                                                                                                             | `contract/model.ts:6-8`; `contract/mod.ts:42-54`                                | Either declare it a versioned interface or narrow the export.                                                                                               | Decision                                     |
| A10 | Medium   | Low-level modules have no isolated tests; `tests/core/internal/` is empty.                                                                                                                                                                   | —                                                                               | Add internal tests for `routing`, `wire`, `validation`, `deadline`, and `check`.                                                                            | No                                           |
| A11 | Low      | `createApp` is a 300-line function mixing option validation, binding, plans, the document endpoint, and the drain state machine; `wire.ts` mixes request decoding and response encoding.                                                     | `runtime/app.ts:116-422`; `runtime/wire.ts`                                     | Extract binding and drain tracking; move `INPUT_KEYS` to the pipeline.                                                                                      | No                                           |
| A12 | Low      | The body reader keeps draining after a timeout wins the race.                                                                                                                                                                                | `runtime/pipeline.ts:173`                                                       | Pass the signal to the limited reader.                                                                                                                      | No                                           |
| A13 | Low      | Dead or duplicated surface: `ProblemCode` is exported and unused; `Validator.accelerated` is never read; `StartupDiagnostic` duplicates `Diagnostic`; `app.ts` writes `console.warn` directly instead of emitting an event.                  | `runtime/problem.ts:6`; `runtime/validation.ts:22`; `runtime/app.ts:83,292`     | Delete or merge.                                                                                                                                            | Changes (`ProblemCode`, `StartupDiagnostic`) |
| A14 | Low      | A user schema named `Problem` silently becomes `application/problem+json`.                                                                                                                                                                   | `contract/check.ts:795-796`; probe                                              | Reserve the name with a diagnostic.                                                                                                                         | No                                           |
| A15 | Low      | Reliance on TypeBox's hidden markers (`~kind`, `~unsafe`, `~codec`, `~refine`) and on derivation keeping non-enumerable keys.                                                                                                                | `contract/schema.ts`, `contract/check.ts`, `contract/infer.ts`                  | Add a test that pins these assumptions, so a TypeBox upgrade fails loudly.                                                                                  | No                                           |
| A16 | Low      | Specification drift: `runtime.md` says the app exposes `health`; it does not. The default style table is duplicated in `check.ts` and `emit.ts`.                                                                                             | `runtime/app.ts:71-80`; `check.ts:128`; `emit.ts:140`                           | Fix the specification; derive the table from the model.                                                                                                     | No                                           |

## Feature findings

### F1. Request bodies (bug)

An operation that declares an object schema with `application/x-www-form-urlencoded` or
`multipart/form-data` passes startup, and its handler is typed with the object, but it receives a
`Uint8Array` and the schema is never checked. Invalid input is answered with 200.

- Evidence: `runtime/wire.ts:230` returns bytes for every non-JSON, non-text media type, and
  `runtime/pipeline.ts:198` skips validation for bytes; probe.
- Recommendation: until form bodies are implemented (a later goal), fail startup with a diagnostic
  when a non-JSON, non-text media type has a schema other than a binary string.

### F2. Security defaults and RBAC

**Works today (probes):**

- Custom schemes through `apiKey`: session cookies (`in: "cookie"`) and identity headers set by an
  mTLS proxy (`in: "header"`).
- Roles as scopes: a verifier maps roles to `scopes`; requirements such as `{ session: ["admin"] }`
  answer 403 for other roles. Non-OAuth scopes are emitted as OpenAPI 3.1 role lists.
- `ctx.security` is typed per alternative.
- Resource-level and tenant checks in handlers through `HttpError(403)`.
- A verifier may throw `HttpError`, for example 403 for a suspended account (`pipeline.ts:217`).

**Gaps:**

| ID   | Finding                                                                                                                                             | Recommendation                                                                                                                                      | Public API        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| F2.1 | **Fail-open default.** An operation with no requirement at the operation, contract, or API level is public without any diagnostic (`check.ts:760`). | A startup diagnostic when schemes exist but an operation has no requirement and no explicit `security: []`.                                         | Adds a diagnostic |
| F2.2 | Denials are visible only as `operation.end` status; the scheme and reason are lost.                                                                 | A read-only `security.denied` event: `operationId`, `status`, `reason` (missing, invalid, insufficient scope), schemes, required scopes.            | Adds              |
| F2.3 | Verifiers do not receive the requirement they are checked against, and `null` always means 401.                                                     | Add `requirement` (the alternative and required scopes) to `VerifierContext`. Document `HttpError` in verifiers, including that it ends evaluation. | Adds              |
| F2.4 | Identity headers from a proxy can be forged unless the proxy strips them.                                                                           | Document the trust model in the security guide.                                                                                                     | No                |
| F2.5 | `plugin-jwt` does not require `audience` or `issuer`.                                                                                               | Require `audience`, or warn at startup without it.                                                                                                  | Plugin            |
| F2.6 | A 401 for apiKey-only operations carries no `WWW-Authenticate`.                                                                                     | Decide and document.                                                                                                                                | No                |
| F2.7 | Central policy has no recipe.                                                                                                                       | A recipe for typed handler wrappers, for example `requireOwner(handler)`, with the 403 declared in the contract.                                    | No                |

### F3. CORS

**Works today (probes):** with `withCors(withRateLimit(app.fetch))`, every status Core produces
(401, 404, 405, 429, 500, 503) carries the CORS headers, preflight is answered by the wrapper with
204 for every route, and `*` with credentials is rejected.

**Gaps:**

| ID   | Finding                                                                                                                                                                                | Recommendation                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| F3.1 | Wrapper order decides correctness, and only the CORS/rate-limit order is documented. With CSRF outside CORS, its 403 lacks CORS headers and it sets its cookie on preflight responses. | Document and test one canonical order: `withCors(withCsrf(withRateLimit(app.fetch)))`. Make CSRF skip preflight requests. |
| F3.2 | `Vary: Origin` is missing when the origin is absent or not allowed, so a shared cache can serve the wrong response.                                                                    | Always add `Vary: Origin` unless origins are `*`.                                                                         |
| F3.3 | No headers are exposed by default, so browsers cannot read `Location`, `Retry-After`, or `RateLimit-*`. The example does not expose `Location`.                                        | Document `exposeHeaders`; fix the example.                                                                                |
| F3.4 | A plain `OPTIONS` (not a preflight) reaches Core and answers 405.                                                                                                                      | Document; no change.                                                                                                      |

None of these changes Core.

### F4. Several OpenAPI documents

**Works today (probes):** several `defineApi` values can share contracts and each emits its own
document (for example public `[pub]` and internal `[pub, internal]`); an outer wrapper can serve
extra documents or mount two apps under prefixes.

**Gaps:** `createApp({ document })` takes one document and serves YAML as JSON; a document subset
does not hide routes from the same app; `serve` closes only one app; routing ignores the path of
`servers[].url`; the CLI configuration has one `api`/`openapi` pair, and `diff` always compares with
`main`.

**Recommendation:**

- Core: `documents: [{ path, content, contentType? }]`, checked for duplicates and route conflicts
  at startup. Core still never imports the emitter.
- `serve`: close several apps, or document closing the others after `finished`.
- Versioning: keep prefixes in contract paths, which stay the source of truth.
- CLI: `hyapi.documents: [{ name, api, openapi }]`, keeping the current pair as shorthand. `emit`,
  `emit --check`, `diff`, and `doctor` work per document; `diff` gains `--document` and `--base`.

### F5. Other production concerns

| ID   | Concern                             | Status                                                                                                                                                         | Recommendation                                                                                                |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| F5.1 | Streaming responses during shutdown | Risk: `close()` returns while a stream is open, `ctx.signal` is not aborted, and resources stop under it. `serve` closes the app and the listener in parallel. | Track open response bodies as in flight; abort streams on shutdown; stop resources after the listener drains. |
| F5.2 | Request correlation                 | Gap: no request ID or `traceparent`; events carry no request reference.                                                                                        | Opt-in request ID on events and responses; a recipe using `AsyncLocalStorage`.                                |
| F5.3 | Error reporting                     | Gap: error events carry only `name` and `message`.                                                                                                             | Include the error (with stack and cause) in the event.                                                        |
| F5.4 | Unmatched requests                  | Gap: 404, 405, and document requests emit no event.                                                                                                            | A `request.unmatched` event.                                                                                  |
| F5.5 | Limits                              | Gap: the body limit is global; timeouts do not cover streamed bodies.                                                                                          | Per-operation body limits, like `timeouts`.                                                                   |
| F5.6 | Streaming result objects            | Risk: a result object holding a `ReadableStream` answers 500 under `enforce`.                                                                                  | Document returning a raw `Response` for streams.                                                              |
| F5.7 | Deployment                          | Gap: no Deno Deploy or container guidance; `--unstable-no-legacy-abort` not verified on Deploy.                                                                | Deployment guide, with liveness and readiness.                                                                |
| F5.8 | Trusted proxies                     | Risk: the example rate-limits on `x-forwarded-for`.                                                                                                            | Document trusted-proxy requirements.                                                                          |
| F5.9 | Load testing                        | Gap: no HTTP-level throughput or memory baseline.                                                                                                              | Add one.                                                                                                      |

## Already in good shape

- Import edges are enforced; `serve` and every plugin use only public entry points.
- One `ContractModel` feeds both the runtime and the emitter, and the emitter is deterministic.
- Startup collects every diagnostic together; lifecycle rollback and close are bounded and aggregate
  errors.
- `problemResponse` never throws, so plugins share one problem shape.
- Development and production defaults are explicit (`development`, `responseValidation`).
- Routing cost is negligible up to about 500 operations ([baseline](../baselines/routing.md)).
