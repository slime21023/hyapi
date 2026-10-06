# RFC 0004: Typed request state

- Status: Accepted (implemented in v1.0.0-rc.5)
- Target: v1.0.0-rc.5

## Problem

`RequestContext.state` and `LifecycleContext.state` are a `Map<string, unknown>`. Every read needs a
cast (`state.get("startedAt") as number | undefined`), string keys can collide between plugins and
modules, and a guard or hook has no typed way to hand data such as a tenant or locale to a handler.

## Decision

Replace the string-keyed map with keys that carry their value type, following the same identity
model as `ServiceReference<T>`.

```ts
export interface StateKey<T> {
  readonly name: string;
  readonly __type?: T;
}

export function defineStateKey<T>(name: string): StateKey<T>;

export interface RequestState {
  get<T>(key: StateKey<T>): T | undefined;
  require<T>(key: StateKey<T>): T;
  set<T>(key: StateKey<T>, value: T): void;
  has(key: StateKey<unknown>): boolean;
}
```

- Keys compare by object identity. `name` only appears in diagnostics, so two keys with the same
  name never share a value.
- `require()` throws a `ConfigurationError` (hidden 500) when the key has no value. A missing value
  means a hook or guard that should have run did not; it is a server composition fault, not a client
  error.
- One `RequestState` instance is shared by hooks, guards, and the handler of a request, exactly as
  the map is today.

## Compatibility and migration

`state` changes type in both contexts. Replace each string key with a module-level key:

```ts
const startedAt = defineStateKey<number>("request-logging.startedAt");
platform.addHook("onRequest", ({ state }) => state.set(startedAt, performance.now()));
platform.addHook("onResponse", ({ state }) => {
  const started = state.get(startedAt) ?? performance.now();
});
```

## Alternatives

- **Keep `Map` and add a generic `get<T>(name)`:** this is a cast with extra steps and keeps
  collisions.
- **Declaration merging on a global state interface:** this is global and implicit, and it fails
  when two packages pick the same property name.

## Acceptance criteria

- Keys with equal names are isolated.
- `require()` on a missing key produces a 500 problem response without exposing the key name.
- The example request-logging plugin uses a typed key and needs no cast.
