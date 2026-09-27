import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import Type from "typebox";
import {
  type AppConfig,
  ConfigurationError,
  createApplication,
  createHttpClient,
  defineHttpContract,
  registerHttpContract,
  withHttpContext,
} from "@hyapi/core";

const config: AppConfig = {
  name: "http-contract-test",
  version: "0.5.0",
  environment: "test",
  requestIdHeader: "x-request-id",
  openapi: {
    enabled: true,
    defaultDocument: "default",
    documents: [{
      id: "default",
      title: "HTTP contract test",
      version: "0.5.0",
      path: "/openapi.json",
    }],
  },
};

const catalogContract = defineHttpContract({
  name: "catalog",
  version: { major: 1, minor: 0 },
  routes: {
    getItem: {
      method: "get",
      path: "/v1/items/{id}",
      request: { params: Type.Object({ id: Type.String() }) },
      responses: { 200: Type.Object({ id: Type.String(), name: Type.String() }) },
      metadata: { summary: "Get catalog item" },
    },
  },
});

Deno.test("HTTP contracts register server routes", async () => {
  const app = await createApplication({
    config,
    modules: [{
      name: "catalog",
      setup(module) {
        registerHttpContract(module, catalogContract, {
          getItem: ({ params, ok }) => ok({ id: params.id, name: "Keyboard" }),
        });
      },
    }],
  });
  const client = createHttpClient({
    baseUrl: "http://test",
    fetch: (input, init) => app.request(input, init),
  });

  const response = await client.fetch("/v1/items/keyboard");
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { id: "keyboard", name: "Keyboard" });
  const openapi = await (await app.request("http://test/openapi.json")).json();
  assertEquals(openapi.paths["/v1/items/{id}"].get.operationId, "getItem");
  await app.close();
});

Deno.test("HTTP clients preserve the base URL path and return the native response", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = createHttpClient({
    baseUrl: "http://gateway/orders-service/",
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ message: "unavailable" }, { status: 503 });
    },
  });

  const response = await client.fetch("/v1/orders?priority=high", {
    method: "POST",
    body: JSON.stringify({ sku: "keyboard" }),
  });
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { message: "unavailable" });
  assertEquals(requests, [{
    url: "http://gateway/orders-service/v1/orders?priority=high",
    init: { method: "POST", body: '{"sku":"keyboard"}' },
  }]);
});

Deno.test("HTTP context propagation supplies headers to the native client", async () => {
  let headers = new Headers();
  const client = createHttpClient({
    baseUrl: "http://orders",
    fetch: async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response();
    },
  });
  await client.fetch(
    "/v1/items/keyboard",
    withHttpContext({
      requestId: "request-123",
      request: new Request("http://orders", { headers: { traceparent: "00-trace-parent-01" } }),
    }, "orders"),
  );

  assertEquals(headers.get("x-request-id"), "request-123");
  assertEquals(headers.get("traceparent"), "00-trace-parent-01");
  assertEquals(headers.get("x-hyapi-service"), "orders");
});

Deno.test("HTTP contract definitions and client paths reject invalid input", async () => {
  assertThrows(
    () => defineHttpContract({ name: "catalog", version: { major: 1, minor: 1.5 }, routes: {} }),
    ConfigurationError,
    "Invalid contract version",
  );
  assertThrows(
    () =>
      defineHttpContract({
        name: "catalog",
        version: { major: 1, minor: 0 },
        routes: { getItem: { ...catalogContract.routes.getItem, path: "v1/items/{id}" } },
      }),
    ConfigurationError,
    "path must start with '/'",
  );
  const client = createHttpClient({ baseUrl: "http://test" });
  await assertRejects(
    () => client.fetch("v1/items"),
    ConfigurationError,
    "paths must start with '/'",
  );
});
