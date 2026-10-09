# Security Policy

## Supported versions

| Version                  | Supported |
| ------------------------ | --------- |
| Latest `0.x` release     | Yes       |
| Older `0.x` releases     | No        |
| `1.0.0-rc.x` (withdrawn) | No        |

Before 1.0.0, fixes are released only for the latest `0.x` version.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Private Vulnerability Reporting: open the
**Security** tab of [slime21023/hyapi](https://github.com/slime21023/hyapi) and choose **Report a
vulnerability**. Do not open a public issue for a suspected vulnerability.

The maintainer replies within 7 days, confirms whether the report is accepted, and coordinates a fix
and disclosure date with the reporter.

## Security defaults

HyAPI applies these defaults. The [user guide](docs/guide/runtime.md) describes every option.

**Contracts and requests**

- Security requirements are declared in the contract and enforced by the runtime, before any input
  is validated. Every declared scheme needs a verifier, or the application does not start.
- Security fails closed: once the API declares a scheme, an operation without a requirement stops
  the application from starting (`implicit-public`); public operations say `security: []`.
- A verifier that throws (for example, because a key server is unreachable) produces a 500 response,
  never an unauthenticated or authorized one.
- Every request is validated against its contract. Request bodies are limited to 1 MiB
  (`bodyLimitBytes`), checked against `Content-Length` and the bytes actually read. Requests time
  out after 30 seconds (`requestTimeoutMs`).
- Paths match exactly, and only declared operations are routed. Unknown `format` values and schema
  constructs that JSON Schema cannot represent stop the application from starting.

**Responses**

- Undeclared response fields are always stripped, so returning a database record cannot leak extra
  properties.
- Outside development mode, error responses never include internal error messages or stack traces.
- Every framework error is an RFC 9457 problem with a stable `code`.
- Events never contain credentials. Request IDs are off by default, and incoming IDs are reused only
  with `trustIncoming`, and only when they are short and contain safe characters.

**Plugins**

- `@hyapi/plugin-jwt` accepts exactly one configured algorithm, requires an audience and `exp`,
  rejects HS256 secrets shorter than 32 bytes, and fails at startup on unusable keys.
- `@hyapi/plugin-oidc` accepts asymmetric algorithms only, requires an audience, checks that the
  discovered issuer matches exactly, and treats key-server failures as errors, not invalid tokens.
- `@hyapi/plugin-cors` has no permissive default: origins are listed explicitly, and `*` cannot be
  combined with credentials.
- `@hyapi/plugin-csrf` signs its tokens with HMAC-SHA-256 and uses a `__Host-` cookie with `Secure`
  by default.
- `@hyapi/plugin-rate-limit` counts per process only; use the edge for limits across instances.

**Implementation**

- HyAPI's own code never generates code at runtime. Validation uses TypeBox, which compiles
  validators where dynamic evaluation is allowed and falls back to interpretation otherwise.
- TLS, compression, security headers, and global rate limiting belong at the reverse proxy or edge.

**Hosting**

- Run with `--unstable-no-legacy-abort`, so that request signals report real client disconnects.
- `serve()` drains in-flight requests on SIGINT and SIGTERM, then closes connections that remain
  open after its shutdown budget.
