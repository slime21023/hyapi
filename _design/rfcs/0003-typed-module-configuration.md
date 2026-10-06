# RFC 0003: Typed module configuration

- Status: Accepted (implemented in v1.0.0-rc.5)
- Target: v1.0.0-rc.5

## Problem

`AppConfig` has a fixed set of framework fields. A module that needs its own settings (a page size,
a downstream base URL, a feature flag) must receive them through a hand-written factory argument,
and nothing validates them before the application starts. The example application parses its
environment ad hoc in `main.ts`.

## Decision

A module may declare a TypeBox schema for its configuration. The application validates every
module's configuration before any module setup runs.

```ts
export interface Module<TConfig extends Schema | undefined = Schema | undefined> {
  readonly name: string;
  readonly config?: TConfig;
  setup(module: ModuleApi<InferSchema<TConfig>>): MaybePromise<void>;
  // existing fields unchanged
}

export function defineModule<TConfig extends Schema | undefined = undefined>(
  module: Module<TConfig>,
): Module<TConfig>;

export interface ApplicationOptions {
  /** Configuration values keyed by module name. */
  readonly moduleConfig?: Readonly<Record<string, unknown>>;
  // existing fields unchanged
}

export interface ModuleApi<TConfig = unknown> {
  /** Validated, defaulted, and frozen configuration. */
  readonly config: TConfig;
  // existing members unchanged
}
```

`defineModule()` is an identity function; it exists only so TypeScript can infer `TConfig` for
`module.config` inside `setup`.

### Validation rules

1. Validation runs during startup, before plugin and module setup, with the same validator used for
   request input: defaults are applied and primitive strings are converted (so environment strings
   such as `"50"` become numbers).
2. A failure throws `ConfigurationError` naming the module, with the schema issues in `details`.
   Configuration errors never reach HTTP clients.
3. A `moduleConfig` entry for an unknown module name, or for a module without a schema, is an error.
4. A module with a schema and no entry is validated against `{}`; the schema decides what is
   required.
5. The validated value is deeply frozen.

Reading the environment remains the application's job. HyAPI does not read `Deno.env`.

```ts
const app = await createApplication({
  config,
  modules: [ordersModule],
  moduleConfig: {
    orders: { pageSize: Deno.env.get("ORDERS_PAGE_SIZE") },
  },
});
```

## Compatibility and migration

This change is additive for modules without a schema. `ModuleApi` and `Module` become generic with
defaults, so existing annotations such as `Module` and `ModuleApi` keep compiling.

## Alternatives

- **A global configuration schema on `AppConfig`:** this couples every module to one shape and
  breaks module ownership.
- **Reading `Deno.env` inside Core:** this is hidden behavior that changes with the environment, and
  it conflicts with explicit dependency injection.

## Acceptance criteria

- Defaults and string conversion are applied before `setup`.
- Unknown module names, configuration for schema-less modules, and invalid values fail startup with
  `ConfigurationError`.
- `module.config` is typed from the schema in a `defineModule` literal.
