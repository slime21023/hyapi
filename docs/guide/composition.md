# Composition

Modules own business routes and services. Plugins add platform-wide lifecycle hooks such as logging
or metrics. A named Port is the boundary between modules.

```ts
import {
  createApplication,
  defineConfig,
  definePort,
  type Module,
  NotFoundError,
  providePort,
} from "@hyapi/core";
import Type from "typebox";

interface UserDirectory {
  find(id: string): Promise<{ id: string } | null>;
}

const userDirectory = definePort<UserDirectory>("users.directory");

const ordersModule: Module = {
  name: "orders",
  requires: [userDirectory],
  setup(module) {
    const users = module.use(userDirectory);
    module.route({
      method: "get",
      path: "/orders/{id}",
      request: { params: Type.Object({ id: Type.String() }) },
      responses: { 200: Type.Object({ id: Type.String() }) },
      handler: async ({ params, ok }) => {
        const user = await users.find(params.id);
        if (!user) throw new NotFoundError();
        return ok(user);
      },
    });
  },
};

const app = await createApplication({
  config: defineConfig({ name: "orders-api" }),
  modules: [ordersModule],
  providers: [providePort(userDirectory, { find: async (id) => id === "ada" ? { id } : null })],
});
```

## Providing a Port from a module

A module declares the Ports it implements in `provides` and implements each one during setup with
`module.provide()`. The factory runs after that module's setup and can resolve its singletons.

```ts
const usersModule: Module = {
  name: "users",
  provides: [userDirectory],
  setup(module) {
    const repository = module.singleton(() => new Map([["ada", { id: "ada" }]]));
    module.provide(userDirectory, async (services) => {
      const users = await services.get(repository);
      return { find: async (id) => users.get(id) ?? null };
    });
  },
};
```

Modules are set up in dependency order, where requiring a Port depends on the module that provides
it, so `module.use()` in a consumer always returns a ready value. Application-level `providers`
remain the way to supply remote (`provideHttp()`) or test providers.

## Module configuration

A module can declare a TypeBox schema for its configuration. Values come from
`createApplication({ moduleConfig })`, keyed by module name, and are validated, defaulted,
converted, and frozen before any setup runs. Use `defineModule()` so `module.config` is typed.

```ts
const ordersModule = defineModule({
  name: "orders",
  config: Type.Object({ pageSize: Type.Integer({ minimum: 1, default: 20 }) }),
  setup(module) {
    const { pageSize } = module.config;
  },
});

await createApplication({
  config,
  modules: [ordersModule],
  moduleConfig: { orders: { pageSize: Deno.env.get("ORDERS_PAGE_SIZE") } },
});
```

HyAPI does not read the environment; the application passes values explicitly.

## Keep boundaries small

- Put a shared Port beside its contract, not inside a provider implementation.
- Declare every consumed Port in `module.requires` before calling `module.use`, and every
  implemented Port in `module.provides` before calling `module.provide`.
- Use `singleton`, `request`, and `transient` services only for the lifetime they need.
- Give plugins platform capabilities; they cannot register module routes.

HyAPI checks missing and incompatible Port providers before accepting requests.
