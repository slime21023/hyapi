# Composition

Modules own business routes and services. Plugins add platform-wide behavior such as authentication
or observability. A named Port is the boundary between modules.

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

## Keep boundaries small

- Put a shared Port beside its contract, not inside a provider implementation.
- Declare every consumed Port in `module.requires` before calling `module.use`.
- Use `singleton`, `request`, and `transient` services only for the lifetime they need.
- Give plugins platform capabilities; they cannot register module routes.

HyAPI checks missing and incompatible Port providers before accepting requests.
