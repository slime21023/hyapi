# ADR 0002: Minimal HyAPI-only public interface for the first release

- Status: Implemented in the 0.5.0 checkout; npm publication pending
- Date: 2026-10-20
- Revised: 2026-10-20 — InferDI replaces the ordinary-parameter-only DI plan
- Scope: Published `hyapi` interface, application composition, HTTP hosting, validation, and documentation

## Context

Before this cutover, the 0.5.0 checkout built an Elysia-native public contract with Ports,
Providers, named Guard phases, and separately assembled protected-route OpenAPI. The ERP example
imported Elysia directly for routes and its listener. Those concepts forced users to learn Elysia
hooks for routine authenticated routes. This decision replaces that checkout contract before the
first public release; no release in this line has been verified as published to npm.

## Decision

- Publish only `hyapi`; keep Elysia and its Bun/Node adapters as implementation details. A
  consumer writes no Elysia route or plugin, and the published interface does not expose Elysia
  types. Keep the private ERP example and application-owned database, transactions, logging, and
  edge policy separate from the framework.
- Compose an application from modules with declarative route lists. A module groups a path prefix,
  shared authentication, and routes; each route holds its handler, relevant request/response
  Standard Schemas, optional resource authorization, and documentation metadata. The framework
  compiles these declarations into Elysia routes at composition time, not through a per-request
  route-forwarding layer. Public routes are declared separately rather than silently opting out
  of an authenticated group.
- Use InferDI as the sole dependency graph. The application creates, configures, and owns a typed
  root container. HyAPI accepts that root, provides typed access to application dependencies in
  module composition, and manages child request scopes for routes that need scoped services.
  Register services with InferDI itself; do not add HyAPI Port, Provider, or parallel registration
  APIs. Business objects still receive ordinary constructor or function arguments, with no
  required framework or container import.
- Group authentication examines the raw request using root dependencies only, before parsing or
  schema validation. Once validation succeeds, HyAPI opens a request scope if the route needs one;
  a protected route first establishes identity, while a public route does not require one.
  Protected scopes can receive the established identity. Route authorization and the handler
  share the scope. HyAPI disposes it when the handler settles, including on errors; a streaming
  body cannot retain scoped services beyond that point.
- InferDI checks the declared graph and lifetimes in TypeScript, with its default runtime guards,
  but cannot prove the runtime behavior of an implementation. Validate external configuration and
  HTTP input with Valibot, and reject invalid route/security declarations before accepting traffic.
- Use two ordinary functions for authorization: group authentication has the raw request and root
  dependencies; route authorization sees validated parameters, query, and body plus the established
  identity and any needed request scope. A protected handler sees its identity directly. Retain the
  401/403 failure boundary and Problem JSON behavior; no public Guard phase object, mount hook, or
  identity lookup by `Request` is required.
- Accept Standard Schema for route validation; Valibot is the primary documented schema library.
  The main OpenAPI conversion path uses `@valibot/to-json-schema`. Other vendors need a usable
  JSON Schema conversion to be documented. Generate documentation from the same route metadata;
  expose its HTTP endpoint only when the application explicitly configures a path. Do not emit an
  incomplete document when a declared schema or protection requirement cannot be represented.
- A normal handler may return data for a 200 response; explicit non-default success statuses use
  a small typed HyAPI response facility. A native `Response` remains available for streams, whose
  body resources the stream itself owns rather than borrowing a returned handler's request scope.
  Application `fetch` remains available for in-process use; HyAPI also provides a Bun/Node listener
  with explicit bind and stop behavior. Stop admission and finish HyAPI-owned request scopes before
  the application disposes its InferDI root and externally supplied resources. No implicit `.env`
  loading, process signal registration, or global network/security policy is added.

## Consequences and release gate

The application retains ownership of the root: HyAPI closes only the child scopes it creates,
including when handlers reject, and application shutdown disposes the root after HyAPI has finished
accepted handlers. InferDI root disposal does not cascade to already-created child scopes; values
supplied with `registerValue` remain application-owned and need their own cleanup. Scope setup
after validation means authentication can use root dependencies but not a request-scoped service.
Do not let a stream read a scope after the handler returns; long-lived stream resources belong to
the stream. TypeScript graph checks cannot prevent casts, `any`, or operationally incorrect service
implementations. Synchronous Valibot route schemas are the initial compatibility target; async
Standard Schema behavior and transformed input/output OpenAPI projection need evidence before
being promised.

Migrate the current ERP example, public declarations, guides, and tests to the new interface before
the first 0.5.0 npm publication. Prove the InferDI root type reaches modules and route scopes
without `any` or exposed Elysia types; concurrent requests have isolated scoped services, and
failed authentication, validation, authorization, handler execution, and shutdown release all
HyAPI-owned scopes. Prove protected malformed requests receive 401 before validation,
authorization receives validated data, and request/response schemas and security appear accurately
in OpenAPI. Verify streaming resources do not outlive their owner, listener shutdown and packed
package HTTP and type consumers on Bun and Node. Previously passing Elysia-native checks do not
verify this replacement contract. Publication and an installed published-package consumer remain
unverified until authorized npm access is available.

The implemented facade exports `createApp`, `reply`, the HTTP errors, and typed module/route
contracts. A consumer passes `createApp({ container, modules: ({ module }) => [...] })`, declares
routes in `routes: (route) => [...]`, and uses `app.fetch`, `app.listen`, and `app.close`.

## Alternatives rejected

- Re-exporting Elysia from `hyapi` merely relocates the import and leaves the consumer bound to its
  hooks and types.
- Ordinary function parameters remain appropriate inside business objects, but using them alone
  does not give HyAPI typed request-scope management. Keeping a separate HyAPI Port/Provider
  container or registration DSL alongside InferDI creates two dependency models.
- HyAPI taking ownership of the application-created InferDI root could dispose a container still
  used elsewhere; opening request scopes before authentication would complicate typed identity
  inputs and cleanup without a demonstrated requirement.
- Named Guard phase objects and independent OpenAPI route registration make the common route path
  harder to understand without improving the required authentication order.

## Revision history

- 2026-10-20: Replace ordinary-parameter-only injection with an application-owned InferDI root
  and HyAPI-owned request scopes.
- 2026-10-20: Implement the clean HyAPI-only cutover in the 0.5.0 checkout; publishing and the
  published-package consumer are still release gates.
- 2026-10-22: Add an explicit `close({ timeoutMs })` caller deadline. It bounds only the caller's
  wait; HyAPI still cannot cancel accepted handlers, which keep their scopes until they settle.
  A reply with a status missing from a declared response contract now fails with a private 500
  instead of bypassing response validation.
- 2026-10-22: Add an observational `onError(error, request)` option for private 500 failures. It
  is not awaited and cannot alter the Problem JSON response; 4xx and 503 are not reported.

## InferDI lifecycle references

- [InferDI scopes and disposal](https://inferdi.com/core/scopes) specifies root/child-scope and
  `registerValue` ownership.
- [InferDI Elysia adapter](https://inferdi.com/adapters/elysia) documents its response-hook cleanup
  and streaming caveat; HyAPI must verify its own scope lifecycle instead of inheriting this
  behavior without a test.
