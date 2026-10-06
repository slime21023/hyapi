import { assertEquals, assertRejects } from "@std/assert";
import { ConfigurationError, createApplication, defineConfig, type Module } from "@hyapi/core";

const config = defineConfig({ name: "overrides" });

const clockModule: Module = {
  name: "clock",
  setup(module) {
    const clock = module.singleton("clock", () => ({ now: () => "real" }));
    module.route({
      method: "get",
      path: "/now",
      handler: async ({ services, ok }) => ok({ now: (await services.get(clock)).now() }),
    });
  },
};

Deno.test("an override replaces the named service it targets", async () => {
  const app = await createApplication({
    config,
    modules: [clockModule],
    overrides: [{ name: "clock", value: { now: () => "fake" } }],
  });
  assertEquals(await (await app.request("/now")).json(), { now: "fake" });
  await app.close();
});

Deno.test("an override that names no service fails startup and is released", async () => {
  const closed: string[] = [];
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [clockModule],
        overrides: [{
          name: "clokc",
          value: { now: () => "fake", close: () => void closed.push("clokc") },
        }],
      }),
    ConfigurationError,
    "Service override 'clokc' does not match any named service. Registered names: clock.",
  );
  assertEquals(closed, ["clokc"]);

  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [],
        overrides: [{ name: "clock", value: {} }],
      }),
    ConfigurationError,
    "Registered names: (none).",
  );
});
