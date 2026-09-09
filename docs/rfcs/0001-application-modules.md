# RFC 0001: Function-first application modules

- Status: Proposed
- Target: v0.2.0
- Related issue: [#4](https://github.com/slime21023/hyapi/issues/4)

## Decision

HyAPI v0.2 replaces the legacy application composition API with an explicit, function-first model:

```ts
const app = await createApplication({
  config,
  modules: [healthModule, usersModule],
  plugins: [jwtPlugin({ secret }), loggingPlugin()],
});
```

Business functionality belongs to `Module`; cross-cutting platform capabilities belong to `Plugin`.
Neither abstraction exposes Hono as a public API. Decorators and reflection metadata are not used.

## Public API shape

```ts
export function defineModule(definition: ModuleDefinition): Module;
export function definePlugin(definition: PluginDefinition): Plugin;
export function createApplication(options: ApplicationOptions): Promise<HyApplication>;
```

`ModuleDefinition` contains a unique `name`, optional `dependencies`, and `setup(module)`. During
setup, the module may register routes, groups, lifecycle hooks, and scoped services.

```ts
export const usersModule = defineModule({
  name: "users",
  setup(module) {
    const repository = module.singleton(() => new UserRepository());
    const service = module.request(() => new UserService(repository()));

    module.group("/v1/users", { tags: ["users"] }, (users) => {
      users.route(listUsersRoute(service));
    });
  },
});
```

Each scoped-service registration returns a typed resolver `() => T`. This keeps ordinary dependency
composition visible in code and avoids introducing service names or tokens for module-internal
services. Calling a request resolver outside a request context is a configuration error.

`PluginDefinition` contains a unique `name`, optional plugin dependencies, and `setup(platform)`.
The platform API may register lifecycle hooks, an auth provider, configuration validators, and
platform-scoped services. It does not expose an underlying Hono object and does not represent a
business module.

## Service scope semantics

| Scope       | Resolution                          | Lifetime                                     | Cleanup                                                     |
| ----------- | ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `singleton` | One lazy instance per application   | application start through close              | close in reverse creation order during application shutdown |
| `request`   | One lazy instance per request       | request dispatch through response completion | close in reverse creation order after response hooks run    |
| `transient` | New instance on every resolver call | caller-owned                                 | HyAPI performs no automatic cleanup                         |

A singleton cannot depend on a request resolver. The application rejects this scope violation when
the singleton factory resolves the request service. Factories can be synchronous or asynchronous;
concurrent resolution of the same singleton or request service shares one initialization result.

Automatic cleanup applies to values implementing `close(): void | Promise<void>`. Cleanup failures
are collected, logged through the platform error hook, and do not prevent remaining resources from
closing.

## Application lifecycle and validation

1. Validate unique plugin and module names.
2. Topologically order plugin dependencies, then module dependencies.
3. Run plugin setup and module setup once.
4. Validate duplicate routes, invalid auth configuration, and unresolved composition references.
5. Start plugins and modules in dependency order.
6. Dispatch requests with request scope active.
7. Close modules and plugins in reverse dependency order; then close singleton services.

Configuration errors include the failing name, the dependency path when relevant, and a concrete
repair suggestion. For example, a cycle reports `orders -> inventory -> orders`; a duplicate route
reports both modules and the method/path.

## Compatibility and migration

This RFC intentionally removes the current public `createApp`, `register`, `PluginApi`, and
`RouterGroup` composition model in v0.2. Existing route contracts, TypeBox schemas, response
helpers, RFC 7807 errors, OpenAPI output, and request testing remain supported through the new
application API.

Migration is one pass:

1. Replace the application root with `createApplication({ config, modules, plugins })`.
2. Move business route registration and local service creation into `defineModule().setup`.
3. Convert JWT, logging, database, and other cross-cutting registration to `definePlugin`.
4. Replace global decorations with scoped service resolvers.
5. Replace `app.ready()` with the resolved result from `createApplication`.

The v0.2 migration guide must provide a complete before/after version of the current example.

## Deferred decisions

Cross-module public APIs, typed ports, and remote providers are deliberately deferred to v0.4 and
v0.5. Modules may declare startup dependencies in v0.2, but they do not export or consume typed
business contracts until the Port API exists.

## Acceptance criteria

- The v0.2 implementation follows this API shape without decorators or Hono public exposure.
- Tests cover all scopes, asynchronous factory deduplication, lifecycle order, cleanup, duplicate
  names, route conflicts, import cycles, and invalid scope resolution.
- The example application and README use Modules for business features and Plugins for platform
  capabilities.
- The migration guide maps every removed composition export to its replacement.
