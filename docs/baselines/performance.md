# Performance baseline

This file records the reference results of `deno task bench`
([`bench/core/app_bench.ts`](../../bench/core/app_bench.ts)). The benchmarks run in-memory requests
through `app.request()` against a production-configured application with the JWT plugin and read
every response body to completion:

- `GET with params+query validation`: `GET /items/{id}` with params, query, and 200 response
  validation.
- `POST JSON body validation`: `POST /items` with a JSON body schema and a 201 response.
- `JWT-protected GET`: `GET /secure` with an HS256 bearer token and the `items:read` scope.
- `OpenAPI document (cached)`: `GET /openapi.json` after the document is cached.

## Regression policy

Compare new results only against a baseline recorded on the same hardware. A pull request that makes
any benchmark more than 20% slower on the same hardware must explain the regression in its
description. Update this file when the reference hardware or the benchmark set changes.

## Environment

Recorded on 2026-09-23.

| Item             | Value                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `deno --version` | deno 2.9.6 (stable, release, x86_64-pc-windows-msvc), V8 15.0.245.2-rusty, TypeScript 6.0.3 |
| CPU              | Intel Core Ultra 7 265KF                                                                    |
| OS               | Windows 11 Home (10.0.26200), x64                                                           |

## Results

Output of `deno task bench` on the environment above:

```text
| benchmark                          | time/iter (avg) |        iter/s |      (min … max)      |      p75 |      p99 |     p995 |
| ---------------------------------- | --------------- | ------------- | --------------------- | -------- | -------- | -------- |
| GET with params+query validation   |         31.6 µs |        31,640 | ( 15.5 µs …   5.6 ms) |  30.0 µs |  96.1 µs | 151.3 µs |
| POST JSON body validation          |         39.7 µs |        25,210 | ( 20.6 µs …   1.9 ms) |  37.5 µs | 106.3 µs | 157.0 µs |
| JWT-protected GET                  |         76.5 µs |        13,070 | ( 40.4 µs …   7.6 ms) |  78.6 µs | 184.0 µs | 278.2 µs |
| OpenAPI document (cached)          |         21.3 µs |        47,000 | ( 13.3 µs …   8.4 ms) |  19.5 µs |  38.8 µs |  67.0 µs |
```
