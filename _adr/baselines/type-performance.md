# Baseline: type-checking performance of the RFC 0001 API

- Date: 2026-10-08
- Purpose: the validation required by [RFC 0001 §9](../rfcs/0001-contract-and-handler-api.md)
- Spike code: [`spikes/type-performance/`](../../spikes/type-performance/). It is throwaway code and
  not part of any package.

## Method

- **Prototype.** `lib/hyapi.ts` implements the RFC 0001 types: `defineSchema`, `defineResponse`,
  `defineSecurity`, `defineContract` with type-level path checks, `defineApi`, `implement`,
  `Handler`, and `createApp` verifiers. Its runtime is minimal.
- **Correctness first.** `check/correctness.ts` type-checks valid code and expects ten errors that
  the RFC promises to catch:
  - a missing path parameter;
  - a security scheme name typo;
  - an undeclared status;
  - a wrong body shape;
  - a missing declared response header;
  - a missing handler;
  - an extra handler;
  - a wrongly typed parameter;
  - a missing verifier; and
  - a public operation that has no security value.

  Each expected error was confirmed by removing its directive and reading the reported error.
- **Generated APIs.** `generate.ts` builds APIs in the RFC 0001 §1 shape. Each resource has:
  - realistic schemas: 12 fields, nested objects, arrays, literal unions, records, and derived
    `T.Omit`/`T.Partial` schemas;
  - named responses; bearer and API-key security, including OR and AND requirements; and
  - every parameter location, a full-form body, response headers, a non-JSON response,
    `notImplemented`, and a `Handler<>`-typed handler in its own declaration.
- **Two shapes.**
  - _Split:_ 10 operations per contract, as the RFC recommends.
  - _Wide:_ 50–100 operations per contract, as a stress case.
- **Measurements.** `measure.ts` measures two things:
  - Full `deno check` time: the median of 3 runs. A cache-busting module is rewritten before each
    run.
  - Editor latency: the TypeScript LanguageService (the same version Deno uses) times the cold check
    of all files. It then edits a contract, a schema, or a handler five times, and takes the median
    time to recompute the semantic diagnostics of the open handler file.
- **Environment.** Deno 2.9.7, TypeScript 6.0.3, TypeBox 1.3.34, Intel Core Ultra 7 265K, 63 GB RAM,
  Windows 11.

## Results

The fixed overhead of `deno check` on the prototype alone (TypeBox and libraries) is about 0.87 s.

| Shape | Operations | Contracts | Files | `deno check` median | LS cold check |  Types | Instantiations | Edit contract | Edit schema | Edit handler |
| ----- | ---------: | --------: | ----: | ------------------: | ------------: | -----: | -------------: | ------------: | ----------: | -----------: |
| split |         50 |         5 |    19 |              1.19 s |       1.24 s* | 14,044 |        105,723 |        167 ms |      150 ms |       148 ms |
| split |        200 |        20 |    64 |              1.47 s |        1.06 s | 34,511 |        308,193 |        148 ms |      151 ms |       151 ms |
| split |        500 |        50 |   154 |              2.17 s |        2.47 s | 75,432 |        713,133 |        167 ms |      165 ms |       164 ms |
| wide  |        100 |         1 |     7 |              1.11 s |        0.79 s | 16,746 |         97,277 |        293 ms |      257 ms |       263 ms |
| wide  |        200 |         2 |    10 |              1.28 s |        0.74 s | 26,273 |        156,327 |        293 ms |      287 ms |       287 ms |
| wide  |        500 |        10 |    34 |              1.75 s |        1.83 s | 57,152 |        375,653 |        242 ms |      235 ms |       230 ms |

\* The first LanguageService run in a process includes JIT warm-up.

No configuration produced type errors in generated code, and none produced "type instantiation is
excessively deep" errors.

## Findings

1. **The targets are met with a wide margin.**
   - A full check of 200 operations takes 1.47 s against a 5 s target. 500 operations take 2.17 s.
   - Editor feedback stays at 150–170 ms against a 1 s target.
   - A slower developer machine, assumed to be 3× slower, would still meet both targets.
2. **Editor latency depends on contract width, not on API size.** Editing one resource rechecks only
   that resource's dependency graph. Latency is flat from 50 to 500 operations, and it roughly
   doubles when one contract holds 100 operations. Splitting contracts by resource, as the RFC
   recommends, is the effective lever.
3. **Instantiations grow linearly**, at about 1,400 per operation in the split shape. Nothing grows
   super-linearly.
4. **`implement` needs `NoInfer` on its handler map.** Without it, a handler written inline in
   `implement()` had its returned `status` widened to `number`, so every inline handler failed to
   type-check. Handlers typed with `Handler<>` were unaffected. With `NoInfer`, the type parameters
   are inferred from the contract only, and inline handlers keep their literal statuses.
5. **Response shorthand relies on TypeBox's `~kind` marker.** TypeBox 1.x declares `TSchema` as an
   empty interface, so any object is structurally a schema. The prototype tells a schema shorthand
   apart from a full response object by the `~kind` property that concrete TypeBox types carry. A
   TypeBox upgrade must keep this marker.
6. **The path-parameter error is readable but incomplete.** It names the rule ("params must declare
   every path parameter") at the offending operation, but it does not list the missing names. A
   template-literal key can include them.
7. **`exactOptionalPropertyTypes` affects handler code.** A handler cannot assign `undefined` to an
   optional response field (`description: body?.reason`). It must omit the field instead. This is a
   property of the strict compiler option, not of the API, but documentation should show the
   pattern.

## Re-running

```text
cd spikes/type-performance
deno run -A generate.ts 50 200 500 100:10 200:10 500:5
deno check check/correctness.ts
deno run -A measure.ts 50 200 500 100w100 200w100 500w50
```
