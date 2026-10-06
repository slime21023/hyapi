import { assert, assertEquals } from "@std/assert";
import { createApplication, defineConfig, type HyApplication, serve } from "@hyapi/core";

/** The port can be bound again only after the listener released it. */
function assertReleased(port: number): void {
  Deno.listen({ hostname: "127.0.0.1", port }).close();
}

async function application(
  release?: Promise<void>,
  entered?: () => void,
): Promise<HyApplication> {
  return await createApplication({
    config: defineConfig({ name: "serve", shutdownTimeoutMs: 2_000 }),
    modules: [{
      name: "probe",
      setup(module) {
        module.route({ method: "get", path: "/ping", handler: ({ ok }) => ok({ pong: true }) });
        module.route({
          method: "get",
          path: "/slow",
          handler: async ({ ok }) => {
            entered?.();
            await release;
            return ok({ done: true });
          },
        });
      },
    }],
  });
}

Deno.test("serve() binds the application and shuts the listener and application down", async () => {
  let listened: Deno.NetAddr | undefined;
  const server = serve(await application(), {
    port: 0,
    onListen: (addr) => listened = addr,
  });
  assertEquals(server.addr.hostname, "127.0.0.1");
  assertEquals(listened?.port, server.addr.port);

  const base = `http://127.0.0.1:${server.addr.port}`;
  assertEquals(await (await fetch(`${base}/ping`)).json(), { pong: true });

  const first = server.shutdown();
  assert(server.shutdown() === first, "shutdown() is memoized");
  await first;
  await server.finished;
  assertReleased(server.addr.port);
});

Deno.test("serve() lets in-flight requests finish during shutdown", async () => {
  const { promise: release, resolve } = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const server = serve(await application(release, entered.resolve), {
    port: 0,
    onListen: () => {},
  });

  const slow = fetch(`http://127.0.0.1:${server.addr.port}/slow`);
  await entered.promise;
  const stopping = server.shutdown();
  resolve();
  const response = await slow;
  assertEquals([response.status, await response.json()], [200, { done: true }]);
  await stopping;
  await server.finished;
});

Deno.test("serve() starts shutdown when its abort signal fires", async () => {
  const controller = new AbortController();
  const server = serve(await application(), {
    port: 0,
    signal: controller.signal,
    onListen: () => {},
  });
  controller.abort();
  await server.finished;
  assertReleased(server.addr.port);
});
