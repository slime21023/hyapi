import { assertEquals } from "@std/assert";
import { createApplication, defineConfig, defineStateKey, type Plugin } from "@hyapi/core";

const tenant = defineStateKey<string>("tenant");
const sameName = defineStateKey<string>("tenant");
const missing = defineStateKey<number>("missing");

const tenantPlugin: Plugin = {
  name: "tenant",
  setup(platform) {
    platform.addHook("onRequest", ({ request, state }) => {
      const value = request.headers.get("x-tenant");
      if (value) state.set(tenant, value);
    });
  },
};

Deno.test("typed request state is shared by hooks and handlers and isolated by key identity", async () => {
  const app = await createApplication({
    config: defineConfig({ name: "state" }),
    plugins: [tenantPlugin],
    modules: [{
      name: "tenants",
      setup(module) {
        module.route({
          method: "get",
          path: "/tenant",
          handler: ({ state, ok }) =>
            ok({
              tenant: state.require(tenant),
              sameName: state.get(sameName) ?? null,
              has: state.has(tenant),
            }),
        });
        module.route({
          method: "get",
          path: "/missing",
          handler: ({ state, ok }) => ok({ value: state.require(missing) }),
        });
      },
    }],
  });

  const found = await app.request("/tenant", { headers: { "x-tenant": "acme" } });
  assertEquals(await found.json(), { tenant: "acme", sameName: null, has: true });

  const unset = await app.request("/missing");
  assertEquals(unset.status, 500);
  const problem = await unset.json();
  assertEquals(problem.code, "CONFIGURATION_ERROR");
  assertEquals(problem.detail, "An unexpected error occurred.");
  await app.close();
});
