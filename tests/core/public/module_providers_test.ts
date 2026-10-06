import { assertEquals, assertRejects } from "@std/assert";
import {
  ConfigurationError,
  createApplication,
  defineConfig,
  definePort,
  type Module,
} from "@hyapi/core";

interface Counter {
  next(): number;
}

const config = defineConfig({ name: "module-providers" });
const counterPort = definePort<Counter>("counter");

function counterModule(events: string[] = []): Module {
  return {
    name: "counter",
    provides: [counterPort],
    setup(module) {
      events.push("counter.setup");
      const state = module.singleton(() => ({ value: 0 }));
      module.provide(counterPort, async (services) => {
        const counter = await services.get(state);
        events.push("counter.provided");
        return { next: () => ++counter.value };
      }, { close: () => void events.push("counter.closed") });
    },
  };
}

function consumerModule(events: string[] = []): Module {
  return {
    name: "consumer",
    requires: [counterPort],
    setup(module) {
      events.push("consumer.setup");
      const counter = module.use(counterPort);
      module.route({
        method: "post",
        path: "/next",
        responseStatus: 200,
        handler: ({ ok }) => ok({ value: counter.next() }),
      });
    },
  };
}

Deno.test("a module implements a Port with its own singleton, ordered before its consumers", async () => {
  const events: string[] = [];
  // Declared consumer-first: Port edges, not array order, decide setup order.
  const app = await createApplication({
    config,
    modules: [consumerModule(events), counterModule(events)],
  });
  assertEquals(events, ["counter.setup", "counter.provided", "consumer.setup"]);
  assertEquals(await (await app.request("/next", { method: "POST" })).json(), { value: 1 });
  assertEquals(await (await app.request("/next", { method: "POST" })).json(), { value: 2 });
  await app.close();
  assertEquals(events.at(-1), "counter.closed");
});

Deno.test("module Port provisions are validated against provides declarations", async () => {
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [{ name: "lazy", provides: [counterPort], setup() {} }],
      }),
    ConfigurationError,
    "Module 'lazy' declares port 'counter' in provides but did not provide it.",
  );
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [{
          name: "sneaky",
          setup(module) {
            module.provide(counterPort, () => ({ next: () => 0 }));
          },
        }],
      }),
    ConfigurationError,
    "Module 'sneaky' provides port 'counter' without declaring it in provides.",
  );
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [counterModule(), { name: "twin", provides: [counterPort], setup() {} }],
      }),
    ConfigurationError,
    "Port 'counter' is provided by both 'counter' and 'twin'.",
  );
});

Deno.test("cycles through Port edges are reported with their path", async () => {
  const aPort = definePort<unknown>("a");
  const bPort = definePort<unknown>("b");
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [
          { name: "alpha", provides: [aPort], requires: [bPort], setup() {} },
          { name: "beta", provides: [bPort], requires: [aPort], setup() {} },
        ],
      }),
    ConfigurationError,
    "Circular module dependency detected: alpha -> beta -> alpha.",
  );
});

Deno.test("module health checks report readiness; liveness stays healthy while draining", async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => release = resolve);
  const app = await createApplication({
    config: defineConfig({ name: "health", shutdownTimeoutMs: 2_000 }),
    modules: [{
      name: "probes",
      setup(module) {
        module.healthCheck({ name: "cache", check: () => ({ status: "degraded" }) });
        module.route({
          method: "get",
          path: "/slow",
          handler: async ({ ok }) => {
            await blocked;
            return ok({});
          },
        });
        module.route({
          method: "get",
          path: "/ready",
          handler: async ({ ok }) => ok(await module.health()),
        });
      },
    }],
  });

  assertEquals(await (await app.request("/ready")).json(), {
    status: "degraded",
    checks: [{ name: "cache", status: "degraded" }],
  });
  assertEquals(app.liveness().status, "healthy");

  const slow = app.request("/slow");
  const closing = app.close();
  assertEquals(app.liveness().status, "healthy");
  assertEquals((await app.health()).status, "unhealthy");
  release();
  await (await slow).body?.cancel();
  await closing;
  assertEquals(app.liveness().status, "unhealthy");
});
