import { assertEquals, assertThrows } from "@std/assert";
import Type from "typebox";
import {
  type AppConfig,
  ConfigurationError,
  createApplication,
  defineHttpContract,
  defineModule,
  definePort,
  provideHttp,
  registerHttpContract,
} from "../mod.ts";

const config: AppConfig = {
  name: "http-provider-test",
  version: "0.5.0",
  environment: "test",
  requestIdHeader: "x-request-id",
  openapi: { title: "HTTP provider test", version: "0.5.0", path: "/openapi.json" },
};

interface UserDirectory {
  find(id: string): Promise<{ id: string } | null>;
}

const userDirectory = definePort<UserDirectory>("users.directory");
const usersContract = defineHttpContract({
  name: "users.directory",
  version: 1,
  routes: {
    find: {
      method: "get",
      path: "/v1/users/{id}",
      request: { params: Type.Object({ id: Type.String() }) },
      responses: { 200: Type.Object({ id: Type.String() }) },
    },
  },
});

Deno.test("provideHttp adapts a shared HTTP contract into a required module port", async () => {
  const usersService = await createApplication({
    config,
    modules: [defineModule({
      name: "users-service",
      setup(module) {
        registerHttpContract(module, usersContract, {
          find: ({ params, ok }) => ok({ id: params.id }),
        });
      },
    })],
  });
  const remoteDirectory = provideHttp(userDirectory, {
    contract: usersContract,
    baseUrl: "http://users-service",
    timeoutMs: 100,
    fetch: (input, init) => usersService.request(input, init),
    adapt: (client) => ({
      find: async (id) => (await client.find({ params: { id } })).body,
    }),
  });
  const orders = await createApplication({
    config,
    providers: [remoteDirectory],
    modules: [defineModule({
      name: "orders",
      requires: [userDirectory],
      setup(module) {
        const users = module.use(userDirectory);
        module.route({
          method: "get",
          path: "/orders/{id}",
          request: { params: Type.Object({ id: Type.String() }) },
          handler: async ({ params, ok }) => ok(await users.find(params.id)),
        });
      },
    })],
  });

  assertEquals(await (await orders.request("http://test/orders/ada")).json(), { id: "ada" });
  await orders.close();
  await usersService.close();
});

Deno.test("provideHttp rejects a contract that cannot implement its port", () => {
  assertThrows(
    () =>
      provideHttp(userDirectory, {
        contract: defineHttpContract({ name: "different", version: 1, routes: {} }),
        baseUrl: "http://users-service",
        timeoutMs: 100,
        adapt: () => ({ find: async () => null }),
      }),
    ConfigurationError,
    "does not match port",
  );
});

Deno.test("provideHttp supports an optional health endpoint", async () => {
  const port = definePort<UserDirectory>("users.directory", { major: 1, minor: 0 });
  const contract = defineHttpContract({ ...usersContract, version: { major: 1, minor: 0 } });
  let status = 200;
  const provider = provideHttp(port, {
    contract,
    baseUrl: "http://users-service",
    timeoutMs: 100,
    healthPath: "/health",
    fetch: () => new Response(null, { status }),
    adapt: () => ({ find: async () => null }),
  });
  assertEquals(await provider.lifecycle?.health?.(), {
    status: "healthy",
    provider: "users.directory",
  });
  status = 503;
  assertEquals(await provider.lifecycle?.health?.(), {
    status: "unhealthy",
    provider: "users.directory",
    detail: "Health endpoint returned 503.",
  });
});
