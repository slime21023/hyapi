# HTTP and OpenAPI

HyAPI keeps a module Port separate from its HTTP representation. This lets an application replace a
local provider with an HTTP provider without making the Port itself depend on transport details.

1. Define a Port for the capability shared by modules.
2. Define a versioned HTTP contract for routes that expose that capability.
3. Adapt `createHttpClient()` and its native `Response` values to the Port interface.
4. Register the HTTP provider with `provideHttp()`.

`defineHttpContract()` validates route paths and shares route metadata across the client and server
boundary. `provideHttp()` checks the contract name and major/minor version before registering a Port
provider.

## Native client behavior

`createHttpClient()` is deliberately small: it resolves a path against one base URL and returns the
native `fetch` response. It does not add retries, status mapping, response validation, or timeouts.
Make those choices in the adapter that knows the Port's semantics.

Use `withHttpContext()` when forwarding an incoming request. It propagates the request ID,
`traceparent`, service name, and deadline headers while leaving the rest of `RequestInit` under the
caller's control.

## OpenAPI output

Route request schemas, response schemas, tags, and guard security metadata form the OpenAPI 3.1
document. Security schemes come only from the guards on documented routes. The output is available
at the configured document paths; the example serves its default document at `/openapi.json`.
