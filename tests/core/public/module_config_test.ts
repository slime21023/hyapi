import { assertEquals, assertRejects } from "@std/assert";
import { ConfigurationError, createApplication, defineConfig, defineModule } from "@hyapi/core";
import Type from "typebox";

const config = defineConfig({ name: "module-config" });

const ordersModule = defineModule({
  name: "orders",
  config: Type.Object({
    pageSize: Type.Integer({ minimum: 1, default: 20 }),
    region: Type.String(),
  }),
  setup(module) {
    const settings = module.config;
    module.route({
      method: "get",
      path: "/settings",
      handler: ({ ok }) => ok({ ...settings, frozen: Object.isFrozen(settings) }),
    });
  },
});

Deno.test("module configuration is validated, defaulted, converted, and frozen before setup", async () => {
  const app = await createApplication({
    config,
    modules: [ordersModule],
    moduleConfig: { orders: { region: "eu" } },
  });
  assertEquals(await (await app.request("/settings")).json(), {
    pageSize: 20,
    region: "eu",
    frozen: true,
  });
  await app.close();

  const converted = await createApplication({
    config,
    modules: [ordersModule],
    moduleConfig: { orders: { region: "us", pageSize: "50" } },
  });
  assertEquals((await (await converted.request("/settings")).json()).pageSize, 50);
  await converted.close();
});

Deno.test("invalid module configuration fails startup with ConfigurationError", async () => {
  const error = await assertRejects(
    () =>
      createApplication({
        config,
        modules: [ordersModule],
        moduleConfig: { orders: { pageSize: 0 } },
      }),
    ConfigurationError,
    "Module 'orders' configuration is invalid.",
  );
  assertEquals((error as ConfigurationError).details !== undefined, true);

  await assertRejects(
    () => createApplication({ config, modules: [ordersModule] }),
    ConfigurationError,
    "Module 'orders' configuration is invalid.",
  );
});

Deno.test("moduleConfig rejects unknown modules and modules without a schema", async () => {
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [ordersModule],
        moduleConfig: { orders: { region: "eu" }, billing: {} },
      }),
    ConfigurationError,
    "moduleConfig references unknown module 'billing'.",
  );
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [{ name: "plain", setup() {} }],
        moduleConfig: { plain: {} },
      }),
    ConfigurationError,
    "Module 'plain' does not declare a configuration schema.",
  );
});
