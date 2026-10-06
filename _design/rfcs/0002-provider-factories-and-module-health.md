# RFC 0002: Module Port providers and module health

- Status: Proposed (implemented for review in v1.0.0-rc.5)
- Target: v1.0.0-rc.5

## Problem

`Module.provides` takes ready-made `PortProvider` values. A value must exist before
`createApplication()` runs, so a module cannot implement a Port with its own singleton services, its
validated configuration, or another Port. The example application therefore constructs its
repository outside the module lifecycle, and its health module captures the application through a
mutable closure (`let application`) to report health.

Health checks can only be registered at the application root, and `app.health()` cannot tell an
orchestrator "alive but draining" apart from "broken".

## Decision

### Providers: `provides` declares, `provide()` implements

Mirror the existing `requires`/`use()` pair.

```ts
export interface Module {
  /** Ports this module implements; each must be provided during setup. */
  readonly provides?: readonly Port<unknown>[];
}

export interface ModuleApi {
  provide<T>(port: Port<T>, factory: ServiceFactory<T>, lifecycle?: ProviderLifecycle): void;
}
```

```ts
export const usersModule = defineModule({
  name: "users",
  provides: [userDirectoryPort],
  setup(module) {
    const repository = module.singleton(() => new InMemoryUserRepository());
    module.provide(userDirectoryPort, async (services) => {
      const users = await services.get(repository);
      return { find: async (id) => toDirectoryEntry(users.findById(id)) };
    });
  },
});
```

Application-level `providers: PortProvider[]`, `providePort()`, and `provideHttp()` are unchanged.
They remain the way to supply remote providers and test substitutes.

### Ordering

Module setup order is the dependency order of explicit `dependencies` plus one implicit edge per
Port: a module that `requires` a Port depends on the module that `provides` it. Cycles through Ports
are reported with the same path format as explicit cycles.

After a module's `setup` returns, the application resolves each of its provider factories with the
singleton resolver and registers the result. A downstream module's `module.use(port)` therefore
stays synchronous. Resolving a request-scoped service from a provider factory is rejected by the
existing scope rule.

### Validation

- Declaring a Port in `provides` without calling `provide()` during setup is a `ConfigurationError`.
- Calling `provide()` for an undeclared Port, or twice for one Port, is a `ConfigurationError`.
- A Port provided both by a module and at application level is a duplicate-provider error, as it is
  today.
- Provider `connect`/`close` lifecycle timing is unchanged: every provider connects after all module
  setup and before `onStart`, and closes in reverse order.

### Module health

```ts
export interface ModuleApi {
  /** Registers a readiness check; names are unique across the application. */
  healthCheck(check: HealthCheck): void;
  /** Readiness report; available once the application is running. */
  health(): Promise<HealthReport>;
  /** Liveness report; does not run checks. */
  liveness(): HealthReport;
}

export interface HyApplication {
  liveness(): HealthReport;
}
```

- `health()` keeps its readiness meaning: checks run only while the application is `running`, so it
  reports `unhealthy` while draining. That takes the instance out of load balancing.
- `liveness()` reports `healthy` while the application is `running` or `draining` and `unhealthy`
  otherwise, so an orchestrator does not kill an instance that is still finishing requests.
- Module health checks join the application's checks. Names are not prefixed automatically.

## Compatibility and migration

`Module.provides` changes from `PortProvider[]` to `Port[]`. Move each `providePort(port, value)`
into `setup` as `module.provide(port, () => value)`, and add the Port to `provides`. CLI `doctor`
reads `provides: [...]` to find module providers.

## Alternatives

- **A `ProviderContext` argument with config, services, and Ports:** `provide()` runs inside setup,
  so its factory already closes over `module.config`, `module.use()`, and service references.
- **Lazy Port values resolved on first use:** this makes `module.use()` asynchronous everywhere and
  hides startup failures until the first request.

## Acceptance criteria

- A provider factory can resolve the module's singletons.
- Modules are ordered by Port edges; Port cycles fail with a path.
- Missing, undeclared, and duplicate provisions fail startup.
- `liveness()` is healthy while draining; `health()` is not.
- The example application no longer constructs services outside modules or captures the application
  in a closure.
