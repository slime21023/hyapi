# RFC 0007: Error diagnostics and default response status

- Status: Accepted (implemented in v1.0.0-rc.5)
- Target: v1.0.0-rc.5

## Problem

A developer who hits an unexpected 500 gets no clue. The problem response says only "An unexpected
error occurred.", nothing is logged, and `AppConfig.environment` changes no behavior anywhere in
Core. The common trigger is a hidden default: a `DELETE` route defaults to 204, so a handler that
returns a body violates the 204 contract and becomes a hidden `RESPONSE_CONTRACT_ERROR`.

## Decision

### Development exposes internal error details

When `environment` is `development`, every problem response includes the information a developer
needs:

- An `AppError` is rendered as if `expose` and `exposeDetails` were true. `detail` is its message,
  and `details` carries its details, such as response validation issues or the declared statuses of
  a contract error.
- Any other thrown `Error` uses its message as `detail` and `{ name, stack }` as `details`. A thrown
  non-`Error` value is reported as `{ thrown: String(value) }`.

`test` and `production` keep internal errors hidden, so tests still assert production behavior.

### The default environment is production

`defineConfig()` defaults `environment` to `production` instead of `development`. Development mode
now discloses internals, so it must be opted into explicitly. Before this RFC `environment` had no
behavior, so the new default changes nothing for applications that never set it to `development`.

### Default status follows the body

Without `responseStatus` or a status from a response helper:

| Handler result     | Status |
| ------------------ | ------ |
| `undefined`        | 204    |
| A body from `POST` | 201    |
| Any other body     | 200    |

The only change is that `DELETE` with a body now returns 200 instead of failing. In OpenAPI, a
`DELETE` route without declared `responses` documents both 200 and 204.

## Compatibility and migration

- Applications that relied on the `development` default without reading it are unaffected. To see
  internal details locally, set `environment: "development"` explicitly.
- A `DELETE` handler that returned a body previously produced a 500 and now produces 200.

## Alternatives

- **A separate `exposeErrors` option:** this is more explicit, but it adds a second switch next to
  an `environment` value that already describes the deployment.
- **Logging 5xx errors from Core:** this picks a log sink and format for the application; `onError`
  hooks remain the place for logging.

## Acceptance criteria

- `development` problems include the internal message and details; `test` and `production` do not.
- `defineConfig()` defaults to `production`.
- `DELETE` with a body returns 200, without one 204; `POST` with a body still returns 201.
