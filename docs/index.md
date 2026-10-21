# HyAPI

HyAPI is a typed HTTP framework for modular applications. It composes HTTP routes, Standard Schema validation, and optional OpenAPI around an application-owned InferDI container. Elysia is an implementation detail: consumers import `hyapi`, not Elysia or Core's private source files.

> **Release status:** `hyapi@0.5.0` is unreleased. The [Quickstart](./guide/quickstart.md) runs from this repository workspace, not from an npm installation. Development requires Bun 1.4.0 and Node 24+.

## Start here

1. [Quickstart](./guide/quickstart.md) — run a database-free HTTP application.
2. [Modules and routes](./guide/modules.md) — define named components and assemble them into an application.
3. [HTTP inputs, responses, and errors](./guide/http.md) — validate data and choose response statuses.
4. [Authentication and authorization](./guide/auth.md) — protect modules and check resource access.
5. [Dependency injection and lifecycle](./guide/di-lifecycle.md) — use InferDI roots and request scopes safely.
6. [OpenAPI](./guide/openapi.md) — publish a schema derived from registered routes.
7. [Testing applications](./guide/testing.md) — choose unit, in-process HTTP, and real-listener checks.

For a larger application, read the [modular ERP example](./examples/erp.md). Use the [Core API reference](./reference/core.md) to check public signatures and options.

A HyAPI module groups routes under a prefix. Your application decides its business boundaries, layering, persistence, authentication policy, transactions, and infrastructure. HyAPI does not generate a business module architecture or register services on your behalf. Familiarity with HTTP and InferDI is assumed.
