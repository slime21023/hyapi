# Baseline: runtime request path

- Date: 2026-10-08
- Purpose: the request-path baseline required by roadmap M2
- Benchmark: [`bench/core/request_bench.ts`](../../bench/core/request_bench.ts), run with
  `deno task bench`
- Environment: Deno 2.9.7, TypeScript 6.0.3, TypeBox 1.3.34 (validators compiled with dynamic code,
  `IsAccelerated() === true`), Intel Core Ultra 7 265K, 63 GB RAM, Windows 11

## Method

The benchmark calls `app.fetch` in process, with no network, for an API whose `Item` schema has
nested objects, arrays, and an `email` format. Every request runs the full M2 path:

- route match;
- parameter reading, defaults, coercion, and validation;
- body reading and validation;
- the handler under the request timeout;
- response stripping and validation, using the default `log` policy; and
- serialization.

A plain `Request → Response.json` handler gives the cost floor of the same round trip without HyAPI.

## Results

| Benchmark                                         | Average | Requests/s |     p75 |     p99 |
| ------------------------------------------------- | ------: | ---------: | ------: | ------: |
| Reference: plain fetch handler, `GET /items/{id}` |  2.2 µs |    461,900 |  2.0 µs |  2.9 µs |
| HyAPI: `GET /items/{id}`                          | 18.5 µs |     54,190 | 16.6 µs | 36.7 µs |
| HyAPI: `GET /items?q&limit&tags` (query decoding) | 28.3 µs |     35,350 | 25.5 µs | 73.2 µs |
| HyAPI: `POST /items` (JSON body)                  | 20.1 µs |     49,720 | 17.7 µs | 44.8 µs |
| HyAPI: 404 for an undeclared path                 |  3.7 µs |    267,300 |  3.5 µs |  5.5 µs |

## Findings

- A validated `GET` costs about 16 µs above the reference handler. That leaves headroom far above
  typical network and handler costs, but it is the starting point for future comparisons.
- Routing is cheap: a 404 costs 1.5 µs above the reference.
- Optimization candidates, not yet measured individually:
  - the response `Clone` + `Clean` + `Check` sequence;
  - the per-request `AbortSignal.any`, `setTimeout`, and `Promise.race`; and
  - `Default` and `Convert` on parameter objects for operations without defaults or non-string
    parameters.

A pull request that slows these benchmarks by more than 20% on the same hardware must explain the
regression (see `CONTRIBUTING.md`).
