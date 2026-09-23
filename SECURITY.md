# Security Policy

## Supported versions

| Version                          | Supported |
| -------------------------------- | --------- |
| Latest `1.0.0-rc.x`              | Yes       |
| Latest 1.x (after 1.0.0 release) | Yes       |
| Older releases                   | No        |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Private Vulnerability Reporting: open the
**Security** tab of [slime21023/hyapi](https://github.com/slime21023/hyapi) and choose **Report a
vulnerability**. Do not open a public issue for a suspected vulnerability.

The maintainer replies within 7 days, confirms whether the report is accepted, and coordinates a fix
and disclosure date with the reporter.

## Security baseline

HyAPI applies the following controls by default:

- **JWT (`jwtPlugin`):** only HS256 tokens are accepted. The secret must contain at least 32 bytes
  (measured as UTF-8). `exp` is required, and `nbf`, `iss`, and `aud` are verified when present or
  configured, within the configured `clockSkewSeconds`. Tokens with a `crit` header parameter are
  rejected. Malformed tokens fail with 401, never 500.
- **Request body limit:** bodies are limited to 10 MiB by default. Configure the limit with
  `bodyLimitBytes`; oversized bodies are rejected with 413 `PAYLOAD_TOO_LARGE`. The limit is
  enforced on the streamed bytes, not only on `Content-Length`.
- **Request timeout:** every request has a 5-minute budget by default. Configure it with
  `requestTimeoutMs`; when it expires, HyAPI aborts `ctx.signal` and responds with 503
  `REQUEST_TIMEOUT`.
- **Request IDs:** an incoming request ID is reused only when it matches `^[A-Za-z0-9._:-]{1,128}$`;
  otherwise HyAPI generates a new UUID.
- **Deadlines:** `x-hyapi-deadline` accepts only 1-15 digit epoch-millisecond values; malformed
  values are ignored. A request whose upstream deadline has already passed is rejected with 504
  `DEADLINE_EXCEEDED` before the handler runs.
- **Error disclosure:** problem details for 5xx responses hide internal error messages.
- **Response filtering:** response bodies are cleaned against the declared response schema, so
  undeclared fields (for example, a `passwordHash`) are never serialized.
- **No framework internals:** Hono is an implementation detail and is not part of the public API;
  handlers, hooks, and plugins cannot reach the underlying router.
