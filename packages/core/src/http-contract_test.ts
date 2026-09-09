import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import Type from "typebox";
import {
  type AppConfig,
  createApplication,
  createHttpContractClient,
  defineHttpContract,
  defineModule,
  HttpContractClientError,
  registerHttpContract,
  ResilienceError,
  withHttpContext,
} from "../mod.ts";

const config: AppConfig = {
  name: "http-contract-test",
  version: "0.5.0",
  environment: "test",
  requestIdHeader: "x-request-id",
  openapi: { title: "HTTP contract test", version: "0.5.0", path: "/openapi.json" },
};

const catalogContract = defineHttpContract({
  name: "catalog",
  version: 1,
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

Deno.test("HTTP contracts register server routes and drive a validated typed client", async () => {
  const app = await createApplication({
    config,
    modules: [defineModule({
      name: "catalog",
      setup(module) {
        registerHttpContract(module, catalogContract, {
          getItem: ({ params, ok }) => ok({ id: params.id, name: "Keyboard" }),
        });
      },
    })],
  });
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    fetch: (input, init) => app.request(input, init),
  });

  assertEquals(await client.getItem({ params: { id: "keyboard" } }), {
    status: 200,
    body: { id: "keyboard", name: "Keyboard" },
  });
  const openapi = await (await app.request("http://test/openapi.json")).json();
  assertEquals(openapi.paths["/v1/items/{id}"].get.operationId, "getItem");
  await app.close();
});

Deno.test("HTTP contract clients reject undeclared statuses and invalid response bodies", async () => {
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    fetch: async () => Response.json({ id: 1 }, { status: 200 }),
  });
  await assertRejects(
    () => client.getItem({ params: { id: "keyboard" } }),
    HttpContractClientError,
    "contract",
  );

  const unexpectedStatusClient = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    fetch: async () => Response.json({ message: "missing" }, { status: 404 }),
  });
  await assertRejects(
    () => unexpectedStatusClient.getItem({ params: { id: "keyboard" } }),
    HttpContractClientError,
    "client",
  );
});

Deno.test("HTTP contract clients time out and retry only idempotent operations", async () => {
  const timeoutClient = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 1,
    fetch: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Timed out", "AbortError")));
      }),
  });
  await assertRejects(
    () => timeoutClient.getItem({ params: { id: "keyboard" } }),
    HttpContractClientError,
    "timeout",
  );

  let attempts = 0;
  const retryingClient = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    retry: { maxAttempts: 2 },
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ message: "temporary" }, { status: 503 })
        : Response.json({ id: "keyboard", name: "Keyboard" });
    },
  });
  assertEquals(await retryingClient.getItem({ params: { id: "keyboard" } }), {
    status: 200,
    body: { id: "keyboard", name: "Keyboard" },
  });
  assertEquals(attempts, 2);
});

Deno.test("HTTP context propagation preserves correlation, trace, and caller identity", async () => {
  let headers = new Headers();
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    fetch: async (_input, init) => {
      headers = new Headers(init?.headers);
      return Response.json({ id: "keyboard", name: "Keyboard" });
    },
  });
  await client.getItem(
    { params: { id: "keyboard" } },
    withHttpContext({
      requestId: "request-123",
      request: new Request("http://orders", { headers: { traceparent: "00-trace-parent-01" } }),
    }, "orders"),
  );
  assertEquals(headers.get("x-request-id"), "request-123");
  assertEquals(headers.get("traceparent"), "00-trace-parent-01");
  assertEquals(headers.get("x-hyapi-service"), "orders");
});

Deno.test("HTTP clients honor propagated deadlines and stop retrying past the budget", async () => {
  let calls = 0;
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    retry: { maxAttempts: 3, delayMs: 100 },
    fetch: async () => {
      calls += 1;
      return Response.json({ message: "temporary" }, { status: 503 });
    },
  });
  const init = withHttpContext({
    requestId: "request-123",
    request: new Request("http://orders"),
    deadline: Date.now() + 20,
  }, "orders");

  await assertRejects(
    () => client.getItem({ params: { id: "keyboard" } }, init),
    HttpContractClientError,
    "timeout",
  );
  assertEquals(calls, 1);
});

Deno.test("HTTP clients reject an expired propagated deadline before fetching", async () => {
  let calls = 0;
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    fetch: async () => {
      calls += 1;
      return Response.json({ id: "keyboard", name: "Keyboard" });
    },
  });
  const init = withHttpContext({
    requestId: "request-123",
    request: new Request("http://orders"),
    deadline: Date.now() - 1,
  }, "orders");

  await assertRejects(
    () => client.getItem({ params: { id: "keyboard" } }, init),
    HttpContractClientError,
    "timeout",
  );
  assertEquals(calls, 0);
});

Deno.test("HTTP clients reject invalid retry budgets at construction", () => {
  assertThrows(
    () =>
      createHttpContractClient(catalogContract, {
        baseUrl: "http://test",
        timeoutMs: 100,
        retry: { maxAttempts: 2, delayMs: -1 },
      }),
    Error,
    "delayMs",
  );
});

Deno.test("HTTP resilience state is shared across calls to the same client", async () => {
  let calls = 0;
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    resilience: { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 1000 } },
    fetch: async () => {
      calls += 1;
      return Response.json({ message: "down" }, { status: 503 });
    },
  });

  await assertRejects(
    () => client.getItem({ params: { id: "keyboard" } }),
    HttpContractClientError,
    "server",
  );
  await assertRejects(
    () => client.getItem({ params: { id: "keyboard" } }),
    ResilienceError,
    "Circuit breaker is open",
  );
  assertEquals(calls, 1);
});

Deno.test("HTTP resilience retries transient failures for safe methods", async () => {
  let calls = 0;
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    resilience: { retry: { maxAttempts: 2, initialDelayMs: 0 } },
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ message: "temporary" }, { status: 503 })
        : Response.json({ id: "keyboard", name: "Keyboard" });
    },
  });

  assertEquals(await client.getItem({ params: { id: "keyboard" } }), {
    status: 200,
    body: { id: "keyboard", name: "Keyboard" },
  });
  assertEquals(calls, 2);
});
