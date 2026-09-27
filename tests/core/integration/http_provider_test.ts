import { assertEquals, assertThrows } from "@std/assert";
import Type from "typebox";
import {
  type AppConfig,
  ConfigurationError,
  createApplication,
  createHttpHealthCheck,
  defineHttpContract,
  definePort,
  definePortContract,
  provideHttp,
  registerHttpContract,
  verifyPortContract,
} from "@hyapi/core";

const config: AppConfig = {
  name: "http-provider-test",
  version: "0.5.0",
  environment: "test",
  requestIdHeader: "x-request-id",
  openapi: {
    enabled: true,
    defaultDocument: "default",
    documents: [{
      id: "default",
      title: "HTTP provider test",
      version: "0.5.0",
      path: "/openapi.json",
    }],
  },
};

interface UserDirectory {
  find(id: string): Promise<{ id: string } | null>;
}

const userDirectory = definePort<UserDirectory>("users.directory");
const usersContract = defineHttpContract({
  name: "users.directory",
  version: { major: 1, minor: 0 },
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
    modules: [{
      name: "users-service",
      setup(module) {
        registerHttpContract(module, usersContract, {
          find: ({ params, ok }) => ok({ id: params.id }),
        });
      },
    }],
  });
  const remoteDirectory = provideHttp(userDirectory, {
    contract: usersContract,
    baseUrl: "http://users-service",
    fetch: (input, init) => usersService.request(input, init),
    adapt: (client) => ({
      find: async (id) => {
        const response = await client.fetch(`/v1/users/${encodeURIComponent(id)}`);
        return response.ok ? await response.json() : null;
      },
    }),
  });
  const orders = await createApplication({
    config,
    providers: [remoteDirectory],
    modules: [{
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
    }],
  });

  assertEquals(await (await orders.request("http://test/orders/ada")).json(), { id: "ada" });
  await orders.close();
  await usersService.close();
});

Deno.test("provideHttp rejects a contract that cannot implement its port", () => {
  assertThrows(
    () =>
      provideHttp(userDirectory, {
        contract: defineHttpContract({
          name: "different",
          version: { major: 1, minor: 0 },
          routes: {},
        }),
        baseUrl: "http://users-service",
        adapt: () => ({ find: async () => null }),
      }),
    ConfigurationError,
    "does not match port",
  );
});

Deno.test("createHttpHealthCheck probes an endpoint under the base URL path", async () => {
  let status = 200;
  let healthUrl = "";
  const check = createHttpHealthCheck({
    name: "users-service",
    baseUrl: "http://gateway/users-service/",
    timeoutMs: 100,
    path: "/health",
    fetch: (input) => {
      healthUrl = String(input);
      return new Response(null, { status });
    },
  });
  assertEquals(await check.check(), {
    status: "healthy",
  });
  assertEquals(healthUrl, "http://gateway/users-service/health");
  status = 503;
  assertEquals(await check.check(), {
    status: "unhealthy",
    detail: "Health endpoint returned 503.",
  });
  assertThrows(
    () =>
      createHttpHealthCheck({
        name: "users-service",
        baseUrl: "http://users-service",
        timeoutMs: 100,
        path: "health",
      }),
    ConfigurationError,
    "path",
  );
});

Deno.test("provideHttp providers pass the shared port contract at the contract version", async () => {
  const usersService = await createApplication({
    config,
    modules: [{
      name: "users-service",
      setup(module) {
        registerHttpContract(module, usersContract, {
          find: ({ params, ok }) => ok({ id: params.id }),
        });
      },
    }],
  });
  const directoryContract = definePortContract<UserDirectory>(
    "users.directory",
    async (directory) => {
      assertEquals(await directory.find("ada"), { id: "ada" });
    },
  );
  const provider = provideHttp(userDirectory, {
    contract: defineHttpContract({ ...usersContract, version: { major: 1, minor: 2 } }),
    baseUrl: "http://users-service",
    fetch: (input, init) => usersService.request(input, init),
    adapt: (client) => ({
      find: async (id) => {
        const response = await client.fetch(`/v1/users/${encodeURIComponent(id)}`);
        return response.ok ? await response.json() : null;
      },
    }),
  });

  await verifyPortContract(directoryContract, provider.value);
  assertEquals(provider.port.version, { major: 1, minor: 2 });
  await usersService.close();
});
