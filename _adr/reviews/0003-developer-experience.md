# Review 0003: Developer experience and troubleshooting

- Status: Accepted. The decisions below are scheduled in [the roadmap](../roadmap.md) as M13, the
  first goal of 0.4.0.
- Date: 2026-10-10
- Scope: `main` at `97257f0` (0.3.0)
- Method: a hands-on walk through the journey of a new user: `hyapi new`, `deno task verify`, the
  running server, five deliberate mistakes in handlers and contracts, and startup with several
  problems at once; then the guide pages that cover the same steps. Every finding below was
  observed, and the fix for F1 was checked with a type-level experiment.

The review asked whether developing with HyAPI is intuitive, and whether a developer who makes a
mistake is told what is wrong and where.

## Verdict

| Step                                  | Experience                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `hyapi new`, `deno task verify`       | Good. The starter has contracts, handlers, tests, CI, and the document, and passes at once.                   |
| Problem responses at runtime          | Good. Every error is RFC 9457 with a code, and violations point to `query /excited`.                          |
| Undeclared parameter, missing handler | Good. One-line type errors.                                                                                   |
| Wrong body field                      | Fair. The useful line ends a six-level message.                                                               |
| **Undeclared status**                 | **Poor. The error is about `Response` missing `headers`; the status is never mentioned.**                     |
| Startup diagnostics                   | Fair. Each states a fix, but without its location, contracts are named by index, and errors come in rounds.   |
| Development loop                      | Fair. No request log; the document must be emitted by hand.                                                   |
| Writing contracts                     | Fair. A needless alias line in every contract; defaults are verbose and have two forms that type differently. |

## Findings

IDs are stable; the roadmap and later changes refer to them.

### F1. An undeclared status reports a misleading error

A handler returns a declared result or a raw `Response`. `Response.status` is a `number`, so a
literal such as `201`, which matches no declared status, widens to `number`, and TypeScript reports
the mismatch against `Response`:

```text
Type '{ status: number; body: { message: string; }; }' is missing the following properties
from type 'Response': headers, ok, redirected, statusText, and 11 more.
```

Without `Response` in the return type, the same mistake reports
`Type '201' is not assignable to
type '404'`. Every handler error also prints the whole operation
declaration through `HandlerFor`.

### F2. Some everyday responses cannot be typed

A response body is typed as the schema's static type, so a binary body
(`T.String({ format:
"binary" })`) is a `string`, and a stream cannot be returned at all, although
the runtime already encodes `Uint8Array`, `Blob`, and `ReadableStream`. Response headers are
`Record<string, string>`, so several `Set-Cookie` values cannot be returned. Server-sent events and
file downloads therefore need a raw `Response`; the runtime guide's event-stream example uses one.

### F3. Startup diagnostics are hard to place

- The message of `StartupError` and `ContractError` drops each diagnostic's location (such as
  `getUser/params/id`), which the CLI prints.
- `missing-implementation` names a contract by its index: `contract 0 has no implementation`.
- A contract error stops startup before implementations and verifiers are checked, so an API with
  three problems reports them over two runs.

### F4. The development loop gives little feedback

- `deno task dev` prints `Listening on …` and nothing per request.
- After a contract change, `openapi.json` is stale until `deno task emit` runs; `verify` catches it
  later.
- The current document is not available in the browser during development.

### F5. Contracts carry needless or confusing code

- Every contract file declares `const T = Type;` after `import Type from "typebox"`; 21 files in the
  starter, the guide, the example, and the tests copy it. `import T from "typebox"` works, including
  `T.TObject` types.
- A default that makes a parameter required in the handler's input is written
  `T.Optional(T.With(T.Integer(), { default: 10 }))`. `T.Integer({ default: 10 })` applies the same
  default at runtime but leaves the input optional.

## Decisions

Taken on 2026-10-10:

| Finding | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1, F2  | **Typed responses only.** Every everyday response is a typed result: `text/*` bodies (including `text/event-stream`) accept a `string` or a `ReadableStream`; bodies that are neither JSON nor text accept `Uint8Array`, `Blob`, or `ReadableStream`, mirroring RFC 0001 A24 for requests; undeclared response headers accept `string` or `readonly string[]`, for several `Set-Cookie` values. A raw `Response` is no longer accepted, with no escape hatch: returning one is a type error, and at runtime it is a contract violation. Breaking. |
| F3      | `StartupError` and `ContractError` print each diagnostic's location, through the formatter the CLI uses. Diagnostics name a contract by its operations instead of its index. Checks that do not depend on the contract model, such as whether every contract has an implementation, run even when the contracts have errors, so one startup reports as much as possible.                                                                                                                                                                          |
| F4      | The starter logs one line per request in development (method, path, status, duration, and problem code; errors with their stack) by connecting `onEvent` to a small logger in the starter, not in Core. `hyapi emit --watch` rewrites the documents when contracts change, and the starter's `dev` task runs it beside the server. The starter serves `/openapi.json` through the existing `documents` option.                                                                                                                                    |
| F5      | `import T from "typebox"` replaces the alias everywhere. A `withDefault(schema, value)` helper declares a parameter default that is required in the handler's input.                                                                                                                                                                                                                                                                                                                                                                              |

The breaking changes (typed responses, the removal of raw `Response`) and the new `withDefault` are
recorded as RFC 0001 amendments when they are implemented.

## Already in good shape

- The workflow of a change (contract, type errors, emit, verify) works as the guide describes.
- Runtime problem responses name the location and the reason of every violation.
- Contract diagnostics state how to fix the problem, and `verify` catches a stale document.
