import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import Type from "typebox";
import {
  type AppConfig,
  ConfigurationError,
  createApplication,
  createHttpContractClient,
  defineHttpContract,
  type HttpContract,
  HttpContractClientError,
  type HttpContractRequest,
  type HttpContractRoute,
  registerHttpContract,
  ResilienceError,
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

const orderContract = defineHttpContract({
  name: "orders",
  version: { major: 1, minor: 0 },
  routes: {
    createOrder: {
      method: "post",
      path: "/v1/orders",
      request: { body: Type.Object({ sku: Type.String() }) },
      responses: { 201: Type.Object({ id: Type.String() }) },
    },
  },
});

const optionalBodyContract = defineHttpContract({
  name: "optional-body",
  version: { major: 1, minor: 0 },
  routes: {
    submit: {
      method: "post",
      path: "/optional",
      request: { body: Type.Object({ value: Type.String() }), bodyRequired: false },
      responses: { 200: Type.Object({ accepted: Type.Boolean() }) },
    },
  },
});

Deno.test("HTTP contract client types and sends an optional request body", async () => {
  const requiredBodyRemainsRequired: {} extends
    Pick<HttpContractRequest<typeof orderContract.routes.createOrder>, "body"> ? false
    : true = true;
  const noBodyRemainsOptional: {} extends
    Pick<HttpContractRequest<typeof catalogContract.routes.getItem>, "body"> ? true
    : false = true;
  assert(requiredBodyRemainsRequired && noBodyRemainsOptional);

  type AnnotatedRoute = HttpContractRoute<
    undefined,
    undefined,
    typeof optionalBodyContract.routes.submit.request.body,
    typeof optionalBodyContract.routes.submit.responses,
    false
  >;
  const annotatedContract: HttpContract<{ submit: AnnotatedRoute }> = optionalBodyContract;
  const bodies: (BodyInit | null | undefined)[] = [];
  const options = {
    baseUrl: "http://test",
    timeoutMs: 100,
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body);
      return Response.json({ accepted: true });
    },
  };
  const client = createHttpContractClient(optionalBodyContract, options);
  const annotatedClient = createHttpContractClient(annotatedContract, options);
  const annotatedRequest: HttpContractRequest<AnnotatedRoute> = {};
  await annotatedClient.submit(annotatedRequest);
  await client.submit({});
  await client.submit({ body: { value: "provided" } });
  assertEquals(bodies, [undefined, undefined, '{"value":"provided"}']);
});

Deno.test("HTTP contracts register server routes and drive a validated typed client", async () => {
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
    resilience: { retry: { maxAttempts: 2, initialDelayMs: 0 } },
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
    resilience: { retry: { maxAttempts: 3, initialDelayMs: 100 } },
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
    "deadline",
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
    "deadline",
  );
  assertEquals(calls, 0);
});

Deno.test("HTTP clients reject invalid retry budgets at construction", () => {
  assertThrows(
    () =>
      createHttpContractClient(catalogContract, {
        baseUrl: "http://test",
        timeoutMs: 100,
        resilience: { retry: { maxAttempts: 2, initialDelayMs: -1 } },
      }),
    Error,
    "initialDelayMs",
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

Deno.test("HTTP contract clients send the declared method and keep the base URL path", async () => {
  const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method, body: init?.body });
    return String(input).endsWith("/v1/orders")
      ? Response.json({ id: "order-1" }, { status: 201 })
      : Response.json({ id: "k", name: "Keyboard" });
  };
  const orders = createHttpContractClient(orderContract, {
    baseUrl: "http://gw/orders-svc",
    timeoutMs: 100,
    fetch,
  });
  const catalog = createHttpContractClient(catalogContract, {
    baseUrl: "http://gw/users-svc/",
    timeoutMs: 100,
    fetch,
  });

  assertEquals(await orders.createOrder({ body: { sku: "kb" } }), {
    status: 201,
    body: { id: "order-1" },
  });
  await catalog.getItem({ params: { id: "k" } });
  assertEquals(requests, [
    { url: "http://gw/orders-svc/v1/orders", method: "POST", body: '{"sku":"kb"}' },
    { url: "http://gw/users-svc/v1/items/k", method: "GET", body: undefined },
  ]);
});

Deno.test("HTTP retries never repeat unsafe requests without an idempotency key", async () => {
  let calls = 0;
  const client = createHttpContractClient(orderContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    resilience: { retry: { maxAttempts: 3, initialDelayMs: 0, retryOn: () => true } },
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ message: "temporary" }, { status: 503 })
        : Response.json({ id: "order-1" }, { status: 201 });
    },
  });

  await assertRejects(
    () => client.createOrder({ body: { sku: "kb" } }),
    HttpContractClientError,
    "server",
  );
  assertEquals(calls, 1);

  calls = 0;
  assertEquals(
    await client.createOrder({ body: { sku: "kb" } }, {
      headers: { "idempotency-key": "order-kb" },
    }),
    { status: 201, body: { id: "order-1" } },
  );
  assertEquals(calls, 2);
});

Deno.test("HTTP clients report caller cancellation as aborted without fetching", async () => {
  let calls = 0;
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    resilience: { retry: { maxAttempts: 3, initialDelayMs: 0 } },
    fetch: async () => {
      calls += 1;
      return Response.json({ id: "k", name: "Keyboard" });
    },
  });
  const controller = new AbortController();
  controller.abort();

  const error = await assertRejects(
    () => client.getItem({ params: { id: "k" } }, { signal: controller.signal }),
    HttpContractClientError,
  );
  assertEquals(error.reason, "aborted");
  assertEquals(calls, 0);
});

Deno.test("HTTP clients reject unserializable bodies as client errors", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const client = createHttpContractClient(orderContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
  });

  const error = await assertRejects(
    () => client.createOrder({ body: circular } as never),
    HttpContractClientError,
  );
  assertEquals(error.reason, "client");
});

Deno.test("HTTP clients honor caller aborts when a custom fetch returns a late response", async () => {
  const controller = new AbortController();
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    fetch: () => {
      controller.abort();
      return Response.json({ id: "k", name: "Keyboard" });
    },
  });

  const error = await assertRejects(
    () => client.getItem({ params: { id: "k" } }, { signal: controller.signal }),
    HttpContractClientError,
  );
  assertEquals(error.reason, "aborted");
});

Deno.test("HTTP clients stop retrying when the caller aborts during backoff", async () => {
  let calls = 0;
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 1000,
    resilience: { retry: { maxAttempts: 2, initialDelayMs: 300 } },
    fetch: () => {
      calls += 1;
      return Response.json({}, { status: 503 });
    },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();

  const error = await assertRejects(
    () => client.getItem({ params: { id: "k" } }, { signal: controller.signal }),
    HttpContractClientError,
  );
  assertEquals(error.reason, "aborted");
  assertEquals(calls, 1);
  assert(Date.now() - started < 200);
});

Deno.test("HTTP deadline failures do not open the circuit breaker", async () => {
  let calls = 0;
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    resilience: { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 1000 } },
    fetch: async () => {
      calls += 1;
      return Response.json({ id: "k", name: "Keyboard" });
    },
  });
  const expired = { headers: { "x-hyapi-deadline": String(Date.now() - 1) } };

  for (let call = 0; call < 3; call += 1) {
    await assertRejects(
      () => client.getItem({ params: { id: "k" } }, expired),
      HttpContractClientError,
      "deadline",
    );
  }
  assertEquals(await client.getItem({ params: { id: "k" } }), {
    status: 200,
    body: { id: "k", name: "Keyboard" },
  });
  assertEquals(calls, 1);
});

Deno.test("HTTP clients forward the earliest effective deadline downstream", async () => {
  let sentHeaders = new Headers();
  const deadline = Date.now() + 1_000;
  const client = createHttpContractClient(catalogContract, {
    baseUrl: "http://test",
    timeoutMs: 100,
    deadline,
    fetch: async (_input, init) => {
      sentHeaders = new Headers(init?.headers);
      return Response.json({ id: "k", name: "Keyboard" });
    },
  });

  await client.getItem({ params: { id: "k" } }, {
    headers: { "x-hyapi-deadline": String(Date.now() + 60_000) },
  });
  assertEquals(sentHeaders.get("x-hyapi-deadline"), String(deadline));
});

Deno.test("HTTP contract definitions reject invalid versions and relative paths", () => {
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
});
