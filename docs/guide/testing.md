# Testing applications

Test the smallest relevant boundary first: application-owned logic without HTTP, then requests through `app.fetch`, then PostgreSQL-backed behavior, and finally a real listener when socket behavior matters. The repository's tests use `node:test` and `node:assert/strict` under Bun and Node.

## Isolated application logic

The ERP application's bearer verifier can be tested without a database, an application, or a listener. This is **application code**, not an authentication provider supplied by HyAPI:

<<< ../../tests/example/auth_unit_test.ts

It signs demonstration JWTs and checks accepted identity as well as rejected credentials. A unit test like this cannot establish route registration, authentication ordering, or HTTP response behavior.

## In-process HTTP and real listeners

For route behavior, call `app.fetch(new Request("http://localhost/path"))` and inspect its `Response`. The [public contract tests](https://github.com/slime21023/hyapi/blob/main/tests/core/public/v05_hyapi_test.ts) exercise public and protected modules, 401/400/403 ordering, scope disposal, composition failures, shutdown, and real listeners without PostgreSQL. These tests create their own InferDI root and close the application and dispose the root they own. `app.fetch` traverses HyAPI's HTTP handling in process but does **not** open a listening socket; use `app.listen` and an actual HTTP request for listener behavior.

The [ERP integration tests](https://github.com/slime21023/hyapi/blob/main/tests/example/v05_erp_test.ts) cover persistent users, inventory, purchases, insufficient-stock rollback, and competing purchases with PostgreSQL. The [OpenAPI and streaming tests](https://github.com/slime21023/hyapi/blob/main/tests/example/v05_openapi_operations_test.ts) check the JSON document and stream lifetime. These are separate from the isolated [auth unit test](https://github.com/slime21023/hyapi/blob/main/tests/example/auth_unit_test.ts). See [Dependency injection and lifecycle](./di-lifecycle.md) for shutdown ownership and the [ERP walkthrough](../examples/erp.md) for manual requests.

## Run the existing suites

From the repository root, use Bun 1.4.0 and Node 24 or newer. The following commands need no PostgreSQL or JWT configuration:

```sh
bun test --timeout 30000 tests/core/public tests/example/auth_unit_test.ts
node --test --test-concurrency=1 --test-timeout=30000 tests/core/public/v05_hyapi_test.ts tests/example/auth_unit_test.ts
```

The following commands require a reachable PostgreSQL 16 database and a private `.env` with the example's `DATABASE_URL` and a random `JWT_SECRET` of at least 32 UTF-8 bytes. Run against a database dedicated to the example; the integration tests create tables and clean up their own rows. The repository's `bunfig.toml` disables implicit `.env` loading, so pass `--env-file=.env` explicitly (or supply environment variables externally). The final `verify` command also runs the repository's cross-cutting checks:

```sh
bun --env-file=.env test --timeout 30000 tests/example
node --env-file=.env --test --test-concurrency=1 --test-timeout=30000 "tests/example/*_test.ts"
bun --env-file=.env run verify
```
