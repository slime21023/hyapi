# Baseline: routing with many operations

- Date: 2026-10-09
- Purpose: decide whether the router's linear scan needs an index
- Benchmark: [`bench/core/routing_bench.ts`](../../bench/core/routing_bench.ts), run with
  `deno task bench`
- Environment: Deno 2.9.7, TypeBox 1.3.34, Intel Core Ultra 7 265K, Windows 11

## Method

The router compiles one regular expression per path template, groups the templates by segment count,
and scans a group in order of specificity. The benchmark builds APIs of 50, 500, and 2,000
operations from resources with five operations each. Three of them share `/r{r}/items/{id}`, so
every resource adds one pattern to the same three-segment group.

Requests go through the public `app.fetch` and use the lightest possible operations (no input, a
one-field response), so routing makes up as large a share of the time as possible:

- **first pattern:** matches the first pattern of the group;
- **last pattern:** matches the last pattern, the worst case for a hit;
- **literal path:** `/r{last}/items`, the last entry of the two-segment group; and
- **404:** scans the whole three-segment group without a match. It isolates routing best.

## Results

| Operations | Patterns in the group | First pattern | Last pattern | Literal path |    404 |
| ---------: | --------------------: | ------------: | -----------: | -----------: | -----: |
|         50 |                    10 |       13.4 µs |      12.2 µs |      13.4 µs | 4.7 µs |
|        500 |                   100 |       15.7 µs |      16.0 µs |      14.6 µs | 5.8 µs |
|      2,000 |                   400 |       14.7 µs |      20.2 µs |      18.5 µs | 9.3 µs |

These are single runs. Matched requests vary by about ±2 µs between runs, which hides differences
below that size, as in the 50-operation row.

## Findings

1. **The scan costs about 11–12 ns per pattern.** The 404 time grows from 4.7 µs (10 patterns) to
   9.3 µs (400 patterns). The difference between the first and last pattern at 2,000 operations
   (about 5.5 µs) matches that rate.
2. **Up to about 500 operations, routing is negligible.** A full scan adds about 1 µs, against 12–20
   µs for even the lightest request. For real handlers, it disappears in I/O.
3. **At 2,000 operations, the worst case adds about 5 µs**, roughly a third of a minimal request.
   That is still small, but it grows linearly.
4. **Literal paths pay the scan too.** `/r{last}/items` has no parameters, yet it waits for the
   whole two-segment group.

## Decision

No change is needed for v1. Typical HyAPI services stay far below the point where routing matters,
and splitting contracts by resource does not affect this cost either way.

Revisit when an application has more than about 1,000 operations with the same segment count. The
improvements, in order of cost:

1. Look up purely literal paths (such as `/health` and `/books`) in a `Map` before scanning. This
   removes finding 4.
2. Index templates by their first literal segment, or use a radix tree, which makes the scan
   independent of the number of operations.

Both are internal to the runtime's routing module and change no public API.
