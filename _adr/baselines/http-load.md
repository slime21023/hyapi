# Baseline: HTTP load and memory

- Date: 2026-10-09
- Purpose: measure HyAPI over real HTTP, and check that memory stays flat under sustained load
  (Review 0001 F5.9)
- Benchmark: [`bench/http/load.ts`](../../bench/http/load.ts), with
  [`bench/http/server.ts`](../../bench/http/server.ts); run with `deno task bench:http`
- Environment: Deno 2.9.7, TypeBox 1.3.34, Intel Core Ultra 7 265K, Windows 11, loopback

## Method

The server runs in its own process with `--unstable-no-legacy-abort` and `--v8-flags=--expose-gc`,
so that the clients do not share its event loop. It serves a validated `GET /items/{id}` and a
`POST /items` with a JSON body. After a warm-up, the clients send requests back to back for five
seconds per run, at 1, 16, and 64 concurrent connections. The server then collects garbage and
reports its heap after each further round of 50,000 requests.

The client is Deno's `fetch` on the same machine, so these numbers include client cost and are a
floor for what a dedicated load generator would measure. Compare runs on the same machine only.

## Results

| Scenario                | Concurrency | Requests/s | p50 (ms) | p99 (ms) |
| ----------------------- | ----------: | ---------: | -------: | -------: |
| GET /items/{id}         |           1 |      9,722 |     0.07 |     0.26 |
| GET /items/{id}         |          16 |     22,060 |     0.64 |     2.14 |
| GET /items/{id}         |          64 |     22,115 |     2.60 |     7.29 |
| POST /items (JSON body) |           1 |      7,681 |     0.11 |     0.29 |
| POST /items (JSON body) |          16 |     17,367 |     0.77 |     2.49 |
| POST /items (JSON body) |          64 |     16,295 |     3.50 |    10.98 |

Throughput levels off at about 16 connections: one Deno process is busy on one core.

| After                 | Heap used (MiB) | RSS (MiB) |
| --------------------- | --------------: | --------: |
| Warm-up and load runs |             9.8 |     126.4 |
| 50,000 more requests  |             9.8 |     126.9 |
| 100,000 more requests |             9.8 |     123.0 |
| 150,000 more requests |             9.8 |     125.2 |

## A leak found and fixed

The first run of this benchmark showed the heap growing by about 116 MiB per 50,000 requests, after
garbage collection: 1,228 MiB after the load runs and 1,596 MiB after 150,000 more requests.

The cause was the request signal. The pipeline combined each request's signal with the application's
shutdown signal through `AbortSignal.any`. Deno keeps a signal made by `AbortSignal.any` reachable
from its sources, and the shutdown signal lives as long as the application, so every request's
signal and its listeners stayed in memory until shutdown, about 1 KB per request. A standalone probe
confirmed it: 100,000 calls of `AbortSignal.any` with one long-lived source retained 85 MiB after
garbage collection.

The fix gives each request its own `AbortController`. The request listens only to its own
`request.signal`, which is collected with the request. At forced shutdown, the application aborts
the controllers of the requests still in flight. Nothing per-request is attached to a long-lived
object any more, and the table above shows a flat heap. `tests/core/public/signals_test.ts` checks
that requests leave no listeners behind and that the request path does not use `AbortSignal.any`.

The micro-benchmark of the request path (`bench/core/request_bench.ts`) shows the fixed version
about 2–3 µs slower for `GET /items/{id}` and `POST /items` than the leaking one, and no difference
for the query-decoding request. In isolation, the new signal setup is faster than `AbortSignal.any`
(2.1 µs against 4.2 µs), so the difference has another cause that we did not isolate. It is within
the run-to-run spread of that benchmark (20.6–24.3 µs), and it is small against the cost of a real
HTTP request.
