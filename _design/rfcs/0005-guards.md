# RFC 0005: Guards for authentication and authorization

- Status: Accepted (implemented in v1.0.0-rc.5)
- Target: v1.0.0-rc.5

## Problem

An application has one `AuthProvider`, and routes opt in with `auth: { scopes }`. As a result:

- an API cannot accept two credential types (for example, an API key and a bearer token);
- OpenAPI always describes a `bearerAuth` JWT scheme, and every 401 sends
  `www-authenticate: Bearer`, whatever the provider actually is;
- authorization is limited to "the identity has all of these scopes", so ownership and other
  request-dependent checks are invisible to the route definition; and
- HS256 JWT verification lives in Core while OIDC verification is a plugin.

## Decision

Replace `AuthProvider` and `auth` with an ordered chain of guards. A guard may establish an
identity, reject the request, or do nothing.

```ts
export interface GuardContext {
  readonly request: Request;
  readonly requestId: string;
  /** Raw route parameters, before schema validation. */
  readonly params: Readonly<Record<string, string>>;
  /** Raw query values, before schema validation. */
  readonly query: Readonly<Record<string, string | string[]>>;
  /** Identity established by an earlier guard, if any. */
  readonly identity: Identity | null;
  readonly state: RequestState;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface GuardSecurity {
  /** OpenAPI security schemes, keyed by scheme name. */
  readonly schemes?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Scopes required by this guard. */
  readonly scopes?: readonly string[];
  /** The guard admits requests without credentials. */
  readonly optional?: boolean;
}

export interface Guard {
  readonly name: string;
  readonly security?: GuardSecurity;
  check(context: GuardContext): MaybePromise<Identity | void>;
}

export function defineGuard(guard: Guard): Guard;
export function anyOf(...guards: Guard[]): Guard;
export function requireScopes(...scopes: string[]): Guard;

export interface Identity {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly claims: Readonly<Record<string, unknown>>;
}
```

Routes and groups take `guards?: readonly Guard[]`:

```ts
module.group("/v1/orders", { guards: [jwtBearer({ secret })] }, (orders) => {
  orders.route({
    method: "post",
    path: "/",
    guards: [requireScopes("orders:write")],
    handler,
  });
});
```

### Semantics

- **Order:** group guards run from the outermost group inwards, then route guards. They run after
  group `onRequest` hooks and before body parsing and schema validation. An unauthenticated request
  therefore receives 401 before any 400, and its body is never read. Checks that need the validated
  body stay in the handler.
- **Inheritance:** groups and routes can only add guards. Nothing can remove an inherited guard,
  which keeps today's "no downgrade" rule.
- **Identity:** a guard that returns an `Identity` sets `ctx.identity` for later guards and the
  handler. If an identity already exists, a second, different identity is a `ConfigurationError`. To
  accept one of several credentials, use `anyOf`.
- **Rejection:** a guard throws an `AppError`, normally `UnauthorizedError` or `ForbiddenError`.
- **`anyOf`:** tries each guard in order and uses the first one that does not throw. If all of them
  throw, it rethrows the first error.
- **`requireScopes`:** with no identity, throws 401; with missing scopes, throws 403.
- **Challenge:** `UnauthorizedError` accepts an optional `challenge`, which becomes
  `www-authenticate`. Core no longer hardcodes `Bearer`.

### OpenAPI projection

- `components.securitySchemes` is the union of the schemes declared by all guards on documented
  routes. If guards declare the same name with different definitions, that is a
  `ConfigurationError`.
- A route's chain projects to one requirement object: each scheme in the chain, carrying the union
  of the chain's scopes. `anyOf` projects to one alternative per branch. An `optional` guard adds
  `{}`.
- A route documents 401 when its chain presents a security scheme or requires an identity (a guard
  declares `scopes`, even an empty list). It documents 403 when a guard declares a non-empty
  `scopes` list or is opaque.
- Guards without `security` metadata are opaque: they add 403 and nothing else.

### Removed

`AuthProvider`, `AuthRequirement`, `PlatformApi.setAuthProvider`, `RouteDefinition.auth`, and
`RouteGroupOptions.auth` are removed. `PlatformApi` keeps `addHook`.

### JWT moves to a plugin

`jwtPlugin` and `JwtAuthProvider` leave Core. `@hyapi/plugin-jwt` exports `jwtBearer(options)`, a
guard with the same HS256 verification rules, an `optional` option, and a `bearerAuth` scheme whose
name can be changed. `@hyapi/plugin-oidc` exports `oidcBearer(options)` instead of a plugin. Both
depend only on the public `@hyapi/core` API.

## Compatibility and migration

| rc.4                                 | rc.5                                               |
| ------------------------------------ | -------------------------------------------------- |
| `plugins: [jwtPlugin({ secret })]`   | `guards: [jwtBearer({ secret })]` on the group     |
| `auth: { scopes: ["a"] }`            | `guards: [jwtBearer(...), requireScopes("a")]`     |
| `auth: { required: false }`          | `guards: [jwtBearer({ secret, optional: true })]`  |
| `platform.setAuthProvider(provider)` | `defineGuard({ name, check })`, attached to groups |
| `Identity { subject, scopes }`       | `Identity { subject, scopes, claims }`             |

## Alternatives

- **Keep `AuthProvider` and add an `authorize` hook:** this still cannot accept two credential
  types, and authentication and authorization remain two separate extension points.
- **Run guards after validation:** this gives guards typed input, but leaks validation errors to
  unauthenticated clients and parses bodies before authentication.
- **A global guard on `PlatformApi`:** route-level declaration keeps the requirement visible where
  the route is defined, and keeps public routes such as health and OpenAPI unaffected.

## Acceptance criteria

- 401 is returned before 400 for an invalid body on a guarded route.
- `anyOf`, `requireScopes` (401/403), inheritance without removal, and identity conflicts are
  covered by public tests.
- OpenAPI security schemes and requirements are projected from guards, with no hardcoded scheme.
- `www-authenticate` comes from the thrown challenge.
- Core has no JWT code. The JWT and OIDC plugins pass their public tests through `@hyapi/core`
  alone.
