# Runtime

`createApp` assembles an API, its implementations, and their verifiers into an application whose
`fetch(request)` serves the contract.

```ts
import { createApp } from "@hyapi/core";

const app = await createApp({
  api,
  implementations: [booksImplementation(repository)],
  verifiers: { bearer: verifyBearer },
  development: Deno.env.get("APP_ENV") !== "production",
});
```

Every problem with the contracts, the implementations, the verifiers, and the options is reported
together in a `StartupError`; no partially started application is returned.

## Options

| Option               | Default                                       | Meaning                                                                                  |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `api`                | required                                      | The `defineApi` value                                                                    |
| `implementations`    | required                                      | Exactly one `implement(...)` per contract                                                |
| `verifiers`          | required when the API declares schemes        | One verifier per security scheme                                                         |
| `development`        | `false`                                       | Adds diagnostic details to errors and reports stripped fields                            |
| `responseValidation` | `"enforce"` in development, otherwise `"log"` | What happens when a response does not match its schema: `off`, `log`, or `enforce` (500) |
| `requestTimeoutMs`   | `30000`                                       | Time allowed per request; exceeding it answers 503                                       |
| `timeouts`           | none                                          | Per-operation timeouts, keyed by `operationId`                                           |
| `bodyLimitBytes`     | `1048576`                                     | Maximum request body size; larger bodies answer 413                                      |
| `lifecycle`          | none                                          | Resources started before serving and stopped on close                                    |
| `health`             | none                                          | A `createHealth` aggregator that reports draining during shutdown                        |
| `onEvent`            | `console.warn` for problem events             | Receives read-only events                                                                |
| `shutdownTimeoutMs`  | `10000`                                       | The drain budget, and the budget for stopping resources                                  |
| `document`           | none                                          | Serves an emitted OpenAPI document at an explicit path                                   |

[Operations](./operations) covers `lifecycle`, `health`, `onEvent`, and shutdown.

## The request path

```text
route match        404, or 405 with Allow; HEAD is served by GET
security           401 or 403
parameters         decode, apply defaults, coerce, validate (400)
body               media type (415), size (413), parse (400), validate (400)
handler            with ctx.signal and the timeout (503); 501 for notImplemented
response           declared status, strip undeclared fields, validate per policy
serialization      JSON, text, or a raw Response
```

Paths match exactly: `/books/` is not `/books`. A more literal template wins over a templated one,
so `/books/mine` is matched before `/books/{id}`.

## Bodies

JSON bodies (`application/json` and `+json`) are parsed and validated. `text/*` bodies are decoded
and validated. Other declared media types reach the handler as bytes. Request bodies are never
coerced.

## Errors

Every error HyAPI produces is an RFC 9457 problem with `type: "about:blank"`, the reason phrase as
`title`, the `status`, and a stable `code`. Validation failures list each violation:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "detail": "The request does not match the operation's contract.",
  "violations": [{ "location": "query", "pointer": "/limit", "message": "must be <= 100" }]
}
```

| Status   | `code`                                          |
| -------- | ----------------------------------------------- |
| 400      | `VALIDATION_FAILED`, `MALFORMED_REQUEST`        |
| 401, 403 | `UNAUTHORIZED`, `FORBIDDEN`                     |
| 404, 405 | `NOT_FOUND`, `METHOD_NOT_ALLOWED`               |
| 413, 415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`   |
| 500      | `INTERNAL_ERROR`, `RESPONSE_CONTRACT_VIOLATION` |
| 501      | `NOT_IMPLEMENTED`                               |
| 503      | `REQUEST_TIMEOUT`, `SHUTTING_DOWN`              |

`problemResponse(status, code, options)` builds the same shape for code outside the runtime, such as
outer `fetch` wrappers.
