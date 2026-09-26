import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type AnyRouteDefinition,
  type AppConfig,
  AppError,
  type AuthProvider,
  createApplication,
  defineConfig,
  definePort,
  definePortContract,
  type Identity,
  NotFoundError,
  providePort,
  type ProviderHealth,
  type RouteGroupApi,
  verifyPortContract,
  verifyPortContracts,
  withHttpContext,
} from "@hyapi/core";
import { expectStatus, requestJson } from "@hyapi/core";
import { ConfigurationError } from "@hyapi/core";
import { createApp } from "../../../packages/core/src/app.ts";
import { sleep } from "../../../packages/core/src/runtime/timers.ts";
import Type from "typebox";

const config: AppConfig = {
  name: "core-test",
  version: "0.1.0",
  environment: "test",
  requestIdHeader: "x-request-id",
  openapi: {
    enabled: true,
    defaultDocument: "default",
    documents: [{ id: "default", title: "Core test API", version: "0.1.0", path: "/openapi.json" }],
  },
};

Deno.test("routes validate input, return typed JSON, and preserve request ids with semantic helpers", async () => {
  const lifecycle: string[] = [];
  const app = createApp({ config });
  app.addHook("onRequest", () => {
    lifecycle.push("request");
  });
  app.addHook("onResponse", () => {
    lifecycle.push("response");
  });
  app.route(
    {
      method: "get",
      path: "/items/{id}",
      request: {
        params: Type.Object({ id: Type.String({ minLength: 2 }) }),
        query: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, default: 10 })) }),
      },
      responses: {
        200: Type.Object({ id: Type.String(), limit: Type.Integer() }),
      },
      handler: ({ params, query, ok }) => {
        lifecycle.push("handler");
        return ok({ id: params.id, limit: query.limit ?? 10 });
      },
    },
  );
  await app.start();

  const response = await app.request("http://test/items/abc?limit=2", {
    headers: { "x-request-id": "request-123" },
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("x-request-id"), "request-123");
  assertEquals(await response.json(), { id: "abc", limit: 2 });
  assertEquals(lifecycle, ["request", "handler", "response"]);

  const defaultedQuery = await app.request("http://test/items/abc");
  assertEquals(defaultedQuery.status, 200);
  assertEquals(await defaultedQuery.json(), { id: "abc", limit: 10 });
  const jsonResult = await requestJson(app, "http://test/items/abc");
  expectStatus(jsonResult.response, 200);
  assertEquals(jsonResult.body, { id: "abc", limit: 10 });

  const invalid = await app.request("http://test/items/a?limit=0");
  assertEquals(invalid.status, 400);
  const problem = await invalid.json();
  assertEquals(problem.code, "VALIDATION_ERROR");
  assertEquals(invalid.headers.get("content-type"), "application/problem+json");
});

Deno.test("request context exposes the effective deadline", async () => {
  let deadline: number | undefined;
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/deadline",
    handler: ({ deadline: value, ok }) => {
      deadline = value;
      return ok({ ok: true });
    },
  });
  await app.start();

  const upstream = Date.now() + 60_000;
  await app.request("http://test/deadline", { headers: { "x-hyapi-deadline": String(upstream) } });
  assertEquals(deadline, upstream);

  const before = Date.now();
  await app.request("http://test/deadline", { headers: { "x-hyapi-deadline": "" } });
  const after = Date.now();
  assert(deadline !== undefined);
  assert(before + 300_000 <= deadline && deadline <= after + 300_000);
});

Deno.test("defineConfig provides ergonomic application defaults", () => {
  assertEquals(defineConfig({ name: "orders" }), {
    name: "orders",
    version: "0.1.0",
    environment: "development",
    requestIdHeader: "x-request-id",
    bodyLimitBytes: 10485760,
    requestTimeoutMs: 300000,
    shutdownTimeoutMs: 30000,
    openapi: {
      enabled: true,
      defaultDocument: "default",
      documents: [{ id: "default", title: "orders API", version: "0.1.0", path: "/openapi.json" }],
    },
  });
});

Deno.test("multiple OpenAPI documents select routes by document ids", async () => {
  const multiConfig = defineConfig({
    name: "multi-document",
    openapi: {
      defaultDocument: "public",
      documents: [
        { id: "public", title: "Public API", path: "/openapi.json" },
        { id: "internal", title: "Internal API", path: "/internal/openapi.json" },
      ],
    },
  });
  const app = createApp({ config: multiConfig });
  app.route({
    method: "get",
    path: "/shared",
    handler: ({ ok }) => ok({ route: "shared" }),
  });
  app.route({
    method: "get",
    path: "/public",
    metadata: { documentIds: ["public"] },
    handler: ({ ok }) => ok({ route: "public" }),
  });
  app.route({
    method: "get",
    path: "/internal",
    metadata: { documentIds: ["internal"] },
    handler: ({ ok }) => ok({ route: "internal" }),
  });
  app.route({
    method: "get",
    path: "/both",
    metadata: { documentIds: ["public", "internal"] },
    handler: ({ ok }) => ok({ route: "both" }),
  });
  app.route({
    method: "get",
    path: "/hidden",
    metadata: { documentIds: [] },
    handler: ({ ok }) => ok({ route: "hidden" }),
  });
  await app.start();

  const publicDocument = await (await app.request("http://test/openapi.json")).json();
  assertEquals(publicDocument.info.title, "Public API");
  assert(publicDocument.paths["/shared"]);
  assert(publicDocument.paths["/public"]);
  assert(publicDocument.paths["/both"]);
  assertEquals(publicDocument.paths["/internal"], undefined);
  assertEquals(publicDocument.paths["/hidden"], undefined);

  const internalDocument = await (await app.request("http://test/internal/openapi.json")).json();
  assertEquals(internalDocument.info.title, "Internal API");
  assert(internalDocument.paths["/internal"]);
  assert(internalDocument.paths["/both"]);
  assertEquals(internalDocument.paths["/shared"], undefined);
  assertEquals(internalDocument.paths["/public"], undefined);
  assertEquals(internalDocument.paths["/hidden"], undefined);
  await app.close();
});

Deno.test("OpenAPI documents reject duplicate paths and unknown route document ids", () => {
  assertThrows(
    () =>
      defineConfig({
        name: "duplicate-paths",
        openapi: {
          documents: [
            { id: "one", path: "/openapi.json" },
            { id: "two", path: "/openapi.json" },
          ],
        },
      }),
    ConfigurationError,
  );

  const app = createApp({ config });
  assertThrows(
    () =>
      app.route({
        method: "get",
        path: "/unknown-document",
        metadata: { documentIds: ["missing"] },
        handler: () => undefined,
      }),
    ConfigurationError,
  );
});

Deno.test("unmatched routes return problem details", async () => {
  const app = createApp({ config });
  await app.start();
  const response = await app.request("http://test/missing");
  assertEquals(response.status, 404);
  const problem = await response.json();
  assertEquals(problem.code, "NOT_FOUND");
  assertStringIncludes(problem.type, "not_found");
});

Deno.test("createApplication composes ordered plugins and modules", async () => {
  const log: string[] = [];
  const app = await createApplication({
    config,
    plugins: [
      {
        name: "logging",
        setup: () => {
          log.push("plugin:setup");
        },
        onStart: () => {
          log.push("plugin:start");
        },
        onClose: () => {
          log.push("plugin:close");
        },
      },
    ],
    modules: [
      {
        name: "dependent",
        dependencies: ["base"],
        setup: (module) => {
          log.push("module:dependent");
          module.route({
            method: "get",
            path: "/modules",
            handler: ({ ok }) => ok({ ok: true }),
          });
        },
        onStart: () => {
          log.push("module:dependent:start");
        },
        onClose: () => {
          log.push("module:dependent:close");
        },
      },
      {
        name: "base",
        setup: () => {
          log.push("module:base");
        },
        onStart: () => {
          log.push("module:base:start");
        },
        onClose: () => {
          log.push("module:base:close");
        },
      },
    ],
  });

  assertEquals(log, [
    "plugin:setup",
    "module:base",
    "module:dependent",
    "plugin:start",
    "module:base:start",
    "module:dependent:start",
  ]);
  assertEquals((await app.request("http://test/modules")).status, 200);
  await app.close();
  await app.close();
  assertEquals(log.slice(-3), ["module:dependent:close", "module:base:close", "plugin:close"]);
});

Deno.test("createApplication rejects invalid module and plugin graphs", async () => {
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [
          { name: "orders", dependencies: ["users"], setup: () => undefined },
        ],
      }),
    ConfigurationError,
    "orders",
  );
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [],
        plugins: [{ name: "a", dependencies: ["b"], setup: () => undefined }],
      }),
    ConfigurationError,
    "a",
  );
});

Deno.test("module services honor singleton request transient scopes and cleanup", async () => {
  let nextId = 0;
  const closed: number[] = [];
  const app = await createApplication({
    config,
    modules: [{
      name: "services",
      setup(module) {
        const singleton = module.singleton(() => ({ id: ++nextId, close: () => closed.push(1) }));
        const request = module.request(() => ({ id: ++nextId, close: () => closed.push(2) }));
        const transient = module.transient(() => ({ id: ++nextId }));
        module.route({
          method: "get",
          path: "/services",
          handler: async ({ services, ok }) => {
            const shared = await services.get(singleton);
            const firstRequest = await services.get(request);
            const secondRequest = await services.get(request);
            const firstTransient = await services.get(transient);
            const secondTransient = await services.get(transient);
            return ok({
              singleton: shared.id,
              request: [firstRequest.id, secondRequest.id],
              transient: [firstTransient.id, secondTransient.id],
            });
          },
        });
      },
    }],
  });

  const first = await (await app.request("http://test/services")).json();
  const second = await (await app.request("http://test/services")).json();
  assertEquals(first, { singleton: 1, request: [2, 2], transient: [3, 4] });
  assertEquals(second, { singleton: 1, request: [5, 5], transient: [6, 7] });
  assertEquals(closed, [2, 2]);
  await app.close();
  assertEquals(closed, [2, 2, 1]);
});

Deno.test("createApplication replaces named services before module setup is used", async () => {
  let factoryCalls = 0;
  const app = await createApplication({
    config,
    overrides: [{ name: "clock", value: { now: () => "test-time" } }],
    modules: [{
      name: "clock",
      setup(module) {
        const clock = module.singleton("clock", () => {
          factoryCalls += 1;
          return { now: () => "production-time" };
        });
        module.route({
          method: "get",
          path: "/clock",
          handler: async ({ services, ok }) => ok({ now: (await services.get(clock)).now() }),
        });
      },
    }],
  });

  assertEquals(await (await app.request("http://test/clock")).json(), { now: "test-time" });
  assertEquals(factoryCalls, 0);
});

Deno.test("modules resolve explicit ports and reject missing or incompatible providers", async () => {
  const userDirectory = definePort<{ find(id: string): string }>("users.directory");
  const app = await createApplication({
    config,
    providers: [providePort(userDirectory, { find: (id) => `user:${id}` })],
    modules: [{
      name: "orders",
      requires: [userDirectory],
      setup(module) {
        const users = module.use(userDirectory);
        module.route({
          method: "get",
          path: "/orders/{id}",
          request: { params: Type.Object({ id: Type.String() }) },
          handler: ({ params, ok }) => ok({ owner: users.find(params.id) }),
        });
      },
    }],
  });
  assertEquals(await (await app.request("http://test/orders/1")).json(), { owner: "user:1" });

  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [
          { name: "missing", requires: [userDirectory], setup: () => undefined },
        ],
      }),
    ConfigurationError,
    "users.directory",
  );
  await assertRejects(
    () =>
      createApplication({
        config,
        providers: [
          providePort(definePort("users.directory", { major: 2, minor: 0 }), { find: () => "" }),
        ],
        modules: [
          { name: "version", requires: [userDirectory], setup: () => undefined },
        ],
      }),
    ConfigurationError,
    "version 1",
  );
});

Deno.test("providers connect, report health, and close in lifecycle order", async () => {
  const events: string[] = [];
  const port = definePort<{ value: string }>("lifecycle.port", { major: 1, minor: 1 });
  const app = await createApplication({
    config,
    modules: [{
      name: "consumer",
      requires: [port],
      setup: (module) => {
        assertEquals(module.use(port).value, "ok");
      },
    }],
    providers: [providePort(port, { value: "ok" }, {
      connect: () => {
        events.push("connect");
      },
      health: () => ({ status: "healthy", provider: "lifecycle.port" }),
      close: () => {
        events.push("close");
      },
    })],
  });
  assertEquals(events, ["connect"]);
  assertEquals(await app.health(), {
    status: "healthy",
    providers: [{ status: "healthy", provider: "lifecycle.port" }],
  });
  await app.close();
  assertEquals(events, ["connect", "close"]);
});

Deno.test("provider connection failure rolls back already connected providers", async () => {
  const events: string[] = [];
  const makeLifecycle = (name: string, fail = false) => ({
    connect: () => {
      events.push(`connect:${name}`);
      if (fail) throw new Error(`connect:${name}`);
    },
    close: () => {
      events.push(`close:${name}`);
    },
  });
  const first = definePort("first");
  const second = definePort("second");
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [],
        providers: [
          providePort(first, {}, makeLifecycle("first")),
          providePort(second, {}, makeLifecycle("second", true)),
        ],
      }),
    AggregateError,
    "Provider connection failed",
  );
  assertEquals(events, ["connect:first", "connect:second", "close:first"]);
});

Deno.test("startup flattens provider rollback errors before plugin cleanup errors", async () => {
  const events: string[] = [];
  const connectFailure = new Error("provider connect failed");
  const firstCloseFailure = new Error("first provider close failed");
  const secondCloseFailure = new Error("second provider close failed");
  const pluginCloseFailure = new Error("plugin close failed");
  const error = await assertRejects(() =>
    createApplication({
      config,
      modules: [],
      providers: [
        providePort(definePort("first.rollback"), {}, {
          connect: () => {
            events.push("connect:first");
          },
          close: () => {
            events.push("close:first");
            throw firstCloseFailure;
          },
        }),
        providePort(definePort("second.rollback"), {}, {
          connect: () => {
            events.push("connect:second");
          },
          close: () => {
            events.push("close:second");
            throw new AggregateError([
              new AggregateError([secondCloseFailure], "inner close failure"),
            ], "outer close failure");
          },
        }),
        providePort(definePort("failed.rollback"), {}, {
          connect: () => {
            events.push("connect:failed");
            throw connectFailure;
          },
        }),
      ],
      plugins: [{
        name: "failing-cleanup",
        setup: () => undefined,
        onClose: () => {
          events.push("close:plugin");
          throw pluginCloseFailure;
        },
      }],
    }), AggregateError);
  assertEquals(error.errors, [
    connectFailure,
    secondCloseFailure,
    firstCloseFailure,
    pluginCloseFailure,
  ]);
  assertStrictEquals((error.cause as AggregateError).cause, connectFailure);
  assertEquals(events, [
    "connect:first",
    "connect:second",
    "connect:failed",
    "close:second",
    "close:first",
    "close:plugin",
  ]);
});

Deno.test("provider minor versions are compatible within the same major", async () => {
  const required = definePort<{ value: string }>("versioned.port", { major: 1, minor: 1 });
  const provided = definePort<{ value: string }>("versioned.port", { major: 1, minor: 2 });
  const app = await createApplication({
    config,
    modules: [{ name: "consumer", requires: [required], setup: () => undefined }],
    providers: [providePort(provided, { value: "ok" })],
  });
  await app.close();
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [{ name: "consumer", requires: [required], setup: () => undefined }],
        providers: [
          providePort(definePort("versioned.port", { major: 2, minor: 0 }), { value: "bad" }),
        ],
      }),
    ConfigurationError,
    "requires version",
  );
});

Deno.test("port contracts verify local and fake providers with named failures", async () => {
  interface UserDirectory {
    find(id: string): Promise<{ id: string } | null>;
  }
  const contract = definePortContract<UserDirectory>("users.directory", async (provider) => {
    assertEquals(await provider.find("ada"), { id: "ada" });
  });
  const local: UserDirectory = { find: async (id) => id === "ada" ? { id } : null };
  const fake: UserDirectory = { find: async () => ({ id: "ada" }) };
  await verifyPortContract(contract, local);
  await verifyPortContract(contract, fake);
  await verifyPortContracts(contract, [local, fake]);
  await assertRejects(
    () => verifyPortContract(contract, { find: async () => null }),
    Error,
    "users.directory",
  );
});

Deno.test("plugins sort topologically, execute onStart and onClose in reverse", async () => {
  const log: string[] = [];
  const pluginA = {
    name: "pluginA",
    dependencies: ["pluginB"],
    setup: () => {
      log.push("setup:A");
    },
    onStart: () => {
      log.push("start:A");
    },
    onClose: () => {
      log.push("close:A");
    },
  };
  const pluginB = {
    name: "pluginB",
    setup: () => {
      log.push("setup:B");
    },
    onStart: () => {
      log.push("start:B");
    },
    onClose: () => {
      log.push("close:B");
    },
  };
  const app = await createApplication({ config, modules: [], plugins: [pluginA, pluginB] });
  assertEquals(log, ["setup:B", "setup:A", "start:B", "start:A"]);
  await app.close();
  assertEquals(log, [
    "setup:B",
    "setup:A",
    "start:B",
    "start:A",
    "close:A",
    "close:B",
  ]);
});

Deno.test("app - serializes concurrent ready calls and rejects late plugins", async () => {
  let setupCount = 0;
  const app = await createApplication({
    config,
    modules: [],
    plugins: [{
      name: "slow-plugin",
      setup: async () => {
        setupCount += 1;
        await Promise.resolve();
      },
    }],
  });
  assertEquals(setupCount, 1);
  await app.close();
});

Deno.test("circular plugin dependencies throw ConfigurationError", async () => {
  const p1 = { name: "p1", dependencies: ["p2"], setup: () => undefined };
  const p2 = { name: "p2", dependencies: ["p1"], setup: () => undefined };
  await assertRejects(
    () => createApplication({ config, modules: [], plugins: [p1, p2] }),
    ConfigurationError,
  );
});

Deno.test("missing plugin dependencies throw ConfigurationError", async () => {
  const p1 = { name: "p1", dependencies: ["missingDep"], setup: () => undefined };
  await assertRejects(
    () => createApplication({ config, modules: [], plugins: [p1] }),
    ConfigurationError,
  );
});

Deno.test("app.group supports nested prefixes, tag and auth inheritance", async () => {
  const app = createApp({ config });
  const mockAuth: AuthProvider = {
    authenticate: (req: Request): Identity | null => {
      const auth = req.headers.get("authorization");
      if (auth === "Bearer valid-token") {
        return { subject: "user-1", scopes: ["users:read", "users:write"], claims: {} };
      }
      return null;
    },
  };
  app.setAuthProvider(mockAuth);

  app.group("/v1", (v1) => {
    v1.group("/users", { tags: ["Users"], auth: { scopes: ["users:read"] } }, (users) => {
      users.route(
        {
          method: "get",
          path: "",
          responses: { 200: Type.Object({ status: Type.String() }) },
          handler: ({ ok }) => ok({ status: "all-users" }),
        },
      );
      users.route(
        {
          method: "get",
          path: "/{id}",
          request: { params: Type.Object({ id: Type.String() }) },
          responses: { 200: Type.Object({ id: Type.String() }) },
          handler: ({ params, ok }) => ok({ id: params.id }),
        },
      );
      users.group({ auth: { scopes: ["users:write"] } }, (writers) => {
        writers.route(
          {
            method: "post",
            path: "",
            responses: { 201: Type.Object({ created: Type.Boolean() }) },
            handler: ({ created }) => created({ created: true }),
          },
        );
      });
    });
  });

  await app.start();

  const openapiRes = await app.request("http://test/openapi.json");
  const doc = await openapiRes.json();
  assert(doc.paths["/v1/users"]);
  assert(doc.paths["/v1/users/{id}"]);
  assertEquals(doc.paths["/v1/users"].get.tags, ["Users"]);
  assertEquals(doc.paths["/v1/users"].get.security, [{ bearerAuth: ["users:read"] }]);
  assertEquals(doc.paths["/v1/users"].post.security, [{
    bearerAuth: ["users:read", "users:write"],
  }]);
  assert(doc.paths["/v1/users"].get.responses["401"]);
  assert(doc.paths["/v1/users"].get.responses["403"]);

  const resWithoutAuth = await app.request("http://test/v1/users");
  assertEquals(resWithoutAuth.status, 401);
  assertEquals(resWithoutAuth.headers.get("www-authenticate"), "Bearer");

  const resWithAuth = await app.request("http://test/v1/users", {
    headers: { authorization: "Bearer valid-token" },
  });
  assertEquals(resWithAuth.status, 200);
  assertEquals(await resWithAuth.json(), { status: "all-users" });

  const resParam = await app.request("http://test/v1/users/42", {
    headers: { authorization: "Bearer valid-token" },
  });
  assertEquals(resParam.status, 200);
  assertEquals(await resParam.json(), { id: "42" });

  const resPost = await app.request("http://test/v1/users", {
    method: "POST",
    headers: { authorization: "Bearer valid-token" },
  });
  assertEquals(resPost.status, 201);
  assertEquals(await resPost.json(), { created: true });
});

Deno.test("ready rejects protected routes without an auth provider", async () => {
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/private",
    auth: {},
    handler: () => "private",
  });
  await assertRejects(() => app.start(), ConfigurationError);
});

Deno.test("multi-status response schema validates matching status code schema", async () => {
  const app = createApp({ config });
  app.route(
    {
      method: "get",
      path: "/multi/{type}",
      request: { params: Type.Object({ type: Type.String() }) },
      responses: {
        200: Type.Object({ type: Type.String(), num: Type.Integer() }),
        201: Type.Object({ createdType: Type.String() }),
      },
      handler: ({ params, ok, created }) => {
        if (params.type === "created") {
          return created({ createdType: "created-val" });
        }
        if (params.type === "invalid") {
          return ok({ type: "invalid", num: "not-a-number" as unknown as number });
        }
        return ok({ type: "ok", num: 100 });
      },
    },
  );
  await app.start();

  const resOk = await app.request("http://test/multi/ok");
  assertEquals(resOk.status, 200);
  assertEquals(await resOk.json(), { type: "ok", num: 100 });

  const resCreated = await app.request("http://test/multi/created");
  assertEquals(resCreated.status, 201);
  assertEquals(await resCreated.json(), { createdType: "created-val" });

  const resInvalid = await app.request("http://test/multi/invalid");
  assertEquals(resInvalid.status, 500);
  const problem = await resInvalid.json();
  assertEquals(problem.code, "RESPONSE_VALIDATION_ERROR");
});

Deno.test("app - rejects undeclared statuses and missing response bodies", async () => {
  const app = createApp({ config });
  const responseSchema = Type.Object({ ok: Type.Boolean() });

  app.route(
    {
      method: "get",
      path: "/undeclared-status",
      responses: { 200: responseSchema },
      handler: ({ json }) => json({ ok: true }, 202),
    },
  );
  app.route(
    {
      method: "get",
      path: "/missing-response-body",
      responses: { 200: responseSchema },
      handler: () => undefined,
    },
  );

  await app.start();

  const undeclared = await app.request("http://test/undeclared-status");
  assertEquals(undeclared.status, 500);
  assertEquals((await undeclared.json()).code, "RESPONSE_CONTRACT_ERROR");

  const missingBody = await app.request("http://test/missing-response-body");
  assertEquals(missingBody.status, 500);
  assertEquals((await missingBody.json()).code, "RESPONSE_CONTRACT_ERROR");
});

Deno.test("app - validates composite response schemas", async () => {
  const app = createApp({ config });
  app.route(
    {
      method: "get",
      path: "/composite-response",
      responses: { 200: Type.Union([Type.String(), Type.Number()]) },
      handler: () => true,
    },
  );
  await app.start();

  const response = await app.request("http://test/composite-response");
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, "RESPONSE_VALIDATION_ERROR");

  const document = await (await app.request("http://test/openapi.json")).json();
  assert(document.paths["/composite-response"].get.responses["200"]);
  assertEquals(
    document.paths["/composite-response"].get.responses["200"].content["application/json"].schema,
    { anyOf: [{ type: "string" }, { type: "number" }] },
  );
});

Deno.test("query array schema coerces single query param to array", async () => {
  const app = createApp({ config });
  app.route(
    {
      method: "get",
      path: "/tags",
      request: {
        query: Type.Object({ tag: Type.Array(Type.String()) }),
      },
      responses: {
        200: Type.Object({ tags: Type.Array(Type.String()) }),
      },
      handler: ({ query, ok }) => ok({ tags: query.tag }),
    },
  );
  await app.start();

  const response = await app.request("http://test/tags?tag=deno");
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result, { tags: ["deno"] });
});

Deno.test("group-scoped hooks execute strictly within group hierarchy", async () => {
  const app = createApp({ config });
  const log: string[] = [];

  app.addHook("onRequest", () => {
    log.push("global:request");
  });
  app.addHook("onResponse", () => {
    log.push("global:response");
  });

  app.route(
    {
      method: "get",
      path: "/public",
      responses: { 200: Type.Object({ ok: Type.Boolean() }) },
      handler: ({ ok }) => {
        log.push("handler:public");
        return ok({ ok: true });
      },
    },
  );

  app.group("/api", (api) => {
    api.addHook("onRequest", () => {
      log.push("api:request");
    });
    api.addHook("onResponse", () => {
      log.push("api:response");
    });

    api.group("/users", (users) => {
      users.addHook("onRequest", () => {
        log.push("users:request");
      });
      users.addHook("onResponse", () => {
        log.push("users:response");
      });

      users.route(
        {
          method: "get",
          path: "",
          responses: { 200: Type.Object({ ok: Type.Boolean() }) },
          handler: ({ ok }) => {
            log.push("handler:users");
            return ok({ ok: true });
          },
        },
      );
    });
  });

  await app.start();

  // Test public route -> only global hooks run
  log.length = 0;
  const resPublic = await app.request("http://test/public");
  assertEquals(resPublic.status, 200);
  assertEquals(log, ["global:request", "handler:public", "global:response"]);

  // Test nested group route -> global and scoped hooks run in hierarchy
  log.length = 0;
  const resUsers = await app.request("http://test/api/users");
  assertEquals(resUsers.status, 200);
  assertEquals(log, [
    "global:request",
    "api:request",
    "users:request",
    "handler:users",
    "users:response",
    "api:response",
    "global:response",
  ]);
});

Deno.test("TypeCompiler validates formats and coerces query params", async () => {
  const app = createApp({ config });
  app.route(
    {
      method: "get",
      path: "/validate",
      request: {
        query: Type.Object({
          email: Type.String({ format: "email" }),
          age: Type.Integer({ minimum: 18 }),
          active: Type.Boolean(),
        }),
      },
      responses: {
        200: Type.Object({
          email: Type.String(),
          age: Type.Integer(),
          active: Type.Boolean(),
        }),
      },
      handler: ({ query, ok }) =>
        ok({
          email: query.email,
          age: query.age,
          active: query.active,
        }),
    },
  );
  await app.start();

  const valid = await app.request("http://test/validate?email=ada@example.com&age=25&active=true");
  assertEquals(valid.status, 200);
  const data = await valid.json();
  assertEquals(data, { email: "ada@example.com", age: 25, active: true });

  const invalidEmail = await app.request(
    "http://test/validate?email=invalid-email&age=25&active=true",
  );
  assertEquals(invalidEmail.status, 400);
  const problem = await invalidEmail.json();
  assertEquals(problem.code, "VALIDATION_ERROR");

  const invalidAge = await app.request(
    "http://test/validate?email=ada@example.com&age=15&active=true",
  );
  assertEquals(invalidAge.status, 400);

  const missingRequiredQuery = await app.request("http://test/validate");
  assertEquals(missingRequiredQuery.status, 400);
});

Deno.test("multi-format body parsing handles form URL-encoded and multipart", async () => {
  const app = createApp({ config });

  app.route(
    {
      method: "post",
      path: "/form",
      request: {
        body: Type.Object({
          title: Type.String(),
          count: Type.Integer(),
        }),
      },
      responses: {
        200: Type.Object({ title: Type.String(), count: Type.Integer() }),
      },
      handler: ({ body, ok }) => ok(body),
    },
  );

  await app.start();

  // Test application/x-www-form-urlencoded
  const formRes = await app.request("http://test/form", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "title=hello&count=42",
  });
  assertEquals(formRes.status, 200);
  assertEquals(await formRes.json(), { title: "hello", count: 42 });

  // Test multipart/form-data
  const formData = new FormData();
  formData.append("title", "multipart-test");
  formData.append("count", "100");
  const multipartRes = await app.request("http://test/form", {
    method: "POST",
    body: formData,
  });
  assertEquals(multipartRes.status, 200);
  assertEquals(await multipartRes.json(), { title: "multipart-test", count: 100 });
});

Deno.test("app - enforces required and optional request bodies without consuming the request", async () => {
  const app = createApp({ config });
  const bodySchema = Type.Object({ name: Type.String() });

  app.route(
    {
      method: "post",
      path: "/required-body",
      request: { body: bodySchema },
      responses: { 200: Type.Object({ name: Type.String(), rawBody: Type.String() }) },
      handler: async ({ body, request, ok }) => {
        const rawBody = await request.text();
        return ok({ ...body, rawBody: JSON.parse(rawBody).name });
      },
    },
  );
  app.route(
    {
      method: "post",
      path: "/optional-body",
      request: { body: bodySchema, bodyRequired: false },
      responses: { 200: Type.Object({ present: Type.Boolean() }) },
      handler: ({ body, ok }) => ok({ present: body !== undefined }),
    },
  );
  app.route(
    {
      method: "post",
      path: "/no-body-schema",
      responses: { 200: Type.Object({ bodyWasParsed: Type.Boolean() }) },
      handler: ({ body, ok }) => ok({ bodyWasParsed: body !== undefined }),
    },
  );

  await app.start();

  const missing = await app.request("http://test/required-body", { method: "POST" });
  assertEquals(missing.status, 400);
  assertEquals((await missing.json()).code, "VALIDATION_ERROR");

  const valid = await app.request("http://test/required-body", {
    method: "POST",
    body: new TextEncoder().encode(JSON.stringify({ name: "Ada" })),
  });
  assertEquals(valid.status, 200);
  assertEquals(await valid.json(), { name: "Ada", rawBody: "Ada" });

  const emptyObject = await app.request("http://test/required-body", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assertEquals(emptyObject.status, 400);

  const optional = await app.request("http://test/optional-body", { method: "POST" });
  assertEquals(optional.status, 200);
  assertEquals(await optional.json(), { present: false });

  const emptyUnsupported = await app.request("http://test/optional-body", {
    method: "POST",
    body: "",
  });
  assertEquals(emptyUnsupported.status, 415);

  const noBodySchema = await app.request("http://test/no-body-schema", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "ignored by the route contract",
  });
  assertEquals(noBodySchema.status, 200);
  assertEquals(await noBodySchema.json(), { bodyWasParsed: false });
});

Deno.test("app - rejects unsupported request media types", async () => {
  const app = createApp({ config });
  app.route(
    {
      method: "post",
      path: "/unsupported-body",
      request: { body: Type.Object({ name: Type.String() }) },
      handler: ({ ok }) => ok({ accepted: true }),
    },
  );
  await app.start();

  const response = await app.request("http://test/unsupported-body", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "not-json",
  });
  assertEquals(response.status, 415);
  assertEquals((await response.json()).code, "UNSUPPORTED_MEDIA_TYPE");
});

Deno.test("typed body media rejection precedes an open stream but not the declared byte limit", async () => {
  const app = createApp({
    config: { ...config, requestTimeoutMs: 80, bodyLimitBytes: 8 },
  });
  app.route({
    method: "post",
    path: "/media-order",
    request: { body: Type.Object({ name: Type.String() }) },
    handler: () => new Response(null, { status: 204 }),
  });
  await app.start();
  let cancelled = false;

  const unsupported = await withinOneSecond(app.request("/media-order", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new ReadableStream<Uint8Array>({
      pull() {
        return Promise.withResolvers<void>().promise;
      },
      cancel() {
        cancelled = true;
        return Promise.withResolvers<void>().promise;
      },
    }),
  }));
  assertEquals(unsupported.status, 415);
  assertEquals((await unsupported.json()).code, "UNSUPPORTED_MEDIA_TYPE");
  assertEquals(cancelled, true);

  const oversized = await app.request("/media-order", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": "9" },
    body: "x",
  });
  assertEquals(oversized.status, 413);
  assertEquals((await oversized.json()).code, "PAYLOAD_TOO_LARGE");
  await app.close();
});

Deno.test("app - rejects duplicate routes", () => {
  const app = createApp({ config });
  const dummyRoute: AnyRouteDefinition = {
    method: "get",
    path: "/items",
    handler: () => "items",
  };

  app.route(dummyRoute);
  assertThrows(() => app.route(dummyRoute), ConfigurationError);
});

Deno.test("app - shares request state across hooks and handler", async () => {
  const app = createApp({ config });
  app.addHook("onRequest", ({ state }) => {
    state.set("userRole", "superadmin");
  });

  app.route(
    {
      method: "get",
      path: "/state-test",
      responses: { 200: Type.Object({ role: Type.String() }) },
      handler: ({ state, ok }) => {
        return ok({ role: state.get("userRole") as string });
      },
    },
  );
  await app.start();

  const res = await app.request("http://test/state-test");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { role: "superadmin" });
});

Deno.test("app - triggers onError hooks on failures", async () => {
  const app = createApp({ config });
  const errorsLogged: string[] = [];

  app.addHook("onError", ({ error }) => {
    if (error instanceof Error) {
      errorsLogged.push(error.message);
    }
  });

  app.route(
    {
      method: "get",
      path: "/fail",
      handler: () => {
        throw new Error("Explicit handler failure");
      },
    },
  );
  await app.start();

  const res = await app.request("http://test/fail");
  assertEquals(res.status, 500);
  assertEquals(errorsLogged, ["Explicit handler failure"]);
});

Deno.test("app - supports optional authentication", async () => {
  const app = createApp({ config });
  const mockAuth: AuthProvider = {
    authenticate: (req: Request): Identity | null => {
      const auth = req.headers.get("authorization");
      if (auth === "Bearer valid-token") {
        return { subject: "user-opt", scopes: ["read"], claims: {} };
      }
      return null;
    },
  };
  app.setAuthProvider(mockAuth);

  app.route(
    {
      method: "get",
      path: "/optional",
      auth: { required: false },
      responses: {
        200: Type.Object({ authenticated: Type.Boolean(), sub: Type.Optional(Type.String()) }),
      },
      handler: ({ identity, ok }) => {
        return ok({
          authenticated: identity !== null,
          ...(identity ? { sub: identity.subject } : {}),
        });
      },
    },
  );
  await app.start();

  // Without token -> succeeds with identity: null
  const resNoToken = await app.request("http://test/optional");
  assertEquals(resNoToken.status, 200);
  assertEquals(await resNoToken.json(), { authenticated: false });

  // With valid token -> succeeds with identity
  const resWithToken = await app.request("http://test/optional", {
    headers: { authorization: "Bearer valid-token" },
  });
  assertEquals(resWithToken.status, 200);
  assertEquals(await resWithToken.json(), { authenticated: true, sub: "user-opt" });
});

Deno.test("app - supports returning raw Response object from handler", async () => {
  const app = createApp({ config });
  app.route(
    {
      method: "get",
      path: "/raw-response",
      handler: () => new Response("custom stream or raw body", { status: 202 }),
    },
  );
  await app.start();

  const res = await app.request("http://test/raw-response");
  assertEquals(res.status, 202);
  assertEquals(await res.text(), "custom stream or raw body");
});

Deno.test("app - enforces the configured request body limit", async () => {
  const app = createApp({ config: { ...config, bodyLimitBytes: 16 } });
  app.route({
    method: "post",
    path: "/limited",
    request: { body: Type.Object({ name: Type.String() }) },
    responses: { 200: Type.Object({ name: Type.String() }) },
    handler: ({ body, ok }) => ok(body),
  });
  await app.start();

  const accepted = await app.request("http://test/limited", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  });
  assertEquals(accepted.status, 200);
  assertEquals(await accepted.json(), { name: "Ada" });

  const streamed = await app.request("http://test/limited", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada Lovelace" }),
  });
  assertEquals(streamed.status, 413);
  assertEquals((await streamed.json()).code, "PAYLOAD_TOO_LARGE");

  const declared = await app.request("http://test/limited", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "1024" },
    body: JSON.stringify({ name: "Ada" }),
  });
  assertEquals(declared.status, 413);
  assertEquals((await declared.json()).code, "PAYLOAD_TOO_LARGE");
});

/** Fails the test instead of hanging CI when a stream-bound response never arrives. */
async function withinOneSecond<T>(promise: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error("timed out after 1 second")), 1000);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("app - enforces bodyLimitBytes on routes without a body schema", async () => {
  let unreadHandlerRan = false;
  const app = createApp({ config: { ...config, bodyLimitBytes: 16 } });
  app.route({
    method: "post",
    path: "/raw",
    responses: { 200: Type.Object({ length: Type.Number() }) },
    handler: async ({ request, ok }) => ok({ length: (await request.text()).length }),
  });
  app.route({
    method: "post",
    path: "/unread",
    handler: () => {
      unreadHandlerRan = true;
      return new Response(null, { status: 204 });
    },
  });
  await app.start();

  const oversized = await app.request("http://test/raw", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "x".repeat(1024),
  });
  assertEquals(oversized.status, 413);
  assertEquals((await oversized.json()).code, "PAYLOAD_TOO_LARGE");

  const small = await app.request("http://test/raw", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "x".repeat(8),
  });
  assertEquals(small.status, 200);
  assertEquals(await small.json(), { length: 8 });

  const declared = await app.request("http://test/unread", {
    method: "POST",
    headers: { "content-type": "text/plain", "content-length": "1024" },
    body: "x",
  });
  assertEquals(declared.status, 413);
  assertEquals((await declared.json()).code, "PAYLOAD_TOO_LARGE");
  assertEquals(unreadHandlerRan, false);
});

Deno.test("app - rejects an oversized open body stream with 413", async () => {
  let cancelled = false;
  const app = createApp({ config: { ...config, bodyLimitBytes: 16 } });
  app.route({
    method: "post",
    path: "/limited",
    request: { body: Type.Object({ name: Type.String() }) },
    handler: () => new Response(null, { status: 204 }),
  });
  await app.start();

  const response = await withinOneSecond(Promise.resolve(app.request("http://test/limited", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        cancelled = true;
      },
    }),
  })));
  assertEquals(response.status, 413);
  assertEquals((await response.json()).code, "PAYLOAD_TOO_LARGE");
  assertEquals(cancelled, true);
});

Deno.test("app - request timeout cancels a stalled body read", async () => {
  let cancelled = false;
  const app = createApp({ config: { ...config, requestTimeoutMs: 20 } });
  app.route({
    method: "post",
    path: "/stalled",
    request: { body: Type.Object({ name: Type.String() }) },
    handler: () => new Response(null, { status: 204 }),
  });
  await app.start();

  const response = await withinOneSecond(Promise.resolve(app.request("http://test/stalled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  })));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "REQUEST_TIMEOUT");
  const settle = Promise.withResolvers<void>();
  setTimeout(settle.resolve, 10);
  await settle.promise;
  assertEquals(cancelled, true);
});

Deno.test("app - error responses do not inherit headers from the replaced response", async () => {
  const app = createApp({ config });
  app.addHook("onResponse", () => {
    throw new Error("hook failed");
  });
  app.route({
    method: "get",
    path: "/redirect",
    handler: () =>
      new Response(null, {
        status: 302,
        headers: { location: "/home", "set-cookie": "session=abc; HttpOnly" },
      }),
  });
  await app.start();

  const response = await app.request("http://test/redirect");
  assertEquals(response.status, 500);
  assertEquals(response.headers.get("content-type"), "application/problem+json");
  assertEquals(response.headers.get("location"), null);
  assertEquals(response.headers.get("set-cookie"), null);
  assert(response.headers.get("x-request-id"));
  await response.body?.cancel();
});

Deno.test("createApplication fills defaults for partial configs", async () => {
  const partial = {
    name: "x",
    requestIdHeader: "x-id",
    openapi: { documents: [{ id: "default", path: "/spec" }] },
  };
  const app = await createApplication({ config: partial, modules: [] });
  assertEquals(app.config, defineConfig(partial));
  const response = await app.request("http://test/spec");
  assertEquals((await response.json()).info, { title: "x API", version: "0.1.0" });
  await app.close();
});

Deno.test("app - accepts structured +json request media types", async () => {
  const app = createApp({ config });
  app.route({
    method: "patch",
    path: "/patch",
    request: { body: Type.Object({ name: Type.String() }) },
    responses: { 200: Type.Object({ name: Type.String() }) },
    handler: ({ body, ok }) => ok(body),
  });
  await app.start();

  const response = await app.request("http://test/patch", {
    method: "PATCH",
    headers: { "content-type": "application/merge-patch+json" },
    body: JSON.stringify({ name: "Ada" }),
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { name: "Ada" });
});

Deno.test("app - replaces malformed request ids and tags immutable responses", async () => {
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/redirect",
    handler: () => Response.redirect("http://test/elsewhere", 302),
  });
  await app.start();

  const malformed = await app.request("http://test/missing", {
    headers: { "x-request-id": "bad value\n" },
  });
  const generatedId = malformed.headers.get("x-request-id");
  assert(generatedId !== null);
  assertMatch(generatedId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assertEquals((await malformed.json()).requestId, generatedId);

  const redirect = await app.request("http://test/redirect", {
    headers: { "x-request-id": "trace-1" },
  });
  assertEquals(redirect.status, 302);
  assertEquals(redirect.headers.get("location"), "http://test/elsewhere");
  assertEquals(redirect.headers.get("x-request-id"), "trace-1");
});

Deno.test("app - request cleanup failures reach onError without replacing the response", async () => {
  const errors: unknown[] = [];
  const app = createApp({ config });
  const connection = app.requestService(() => ({
    close: () => {
      throw new Error("close failed");
    },
  }));
  app.addHook("onError", ({ error }) => {
    errors.push(error);
  });
  app.route({
    method: "get",
    path: "/cleanup",
    handler: async ({ services, ok }) => {
      await services.get(connection);
      return ok({ ok: true });
    },
  });
  await app.start();

  const response = await app.request("http://test/cleanup");
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
  assertEquals(errors.length, 1);
  assert(errors[0] instanceof AggregateError);
  assertEquals(errors[0].errors.map((error: Error) => error.message), ["close failed"]);
});

Deno.test("never-settling cleanup error observer cannot replace or stall a chosen response", async () => {
  const errors: unknown[] = [];
  const app = createApp({
    config: { ...config, requestTimeoutMs: 150, shutdownTimeoutMs: 20 },
  });
  const connection = app.requestService(() => ({
    close: () => {
      throw new Error("close failed");
    },
  }));
  app.addHook("onError", ({ error }) => {
    errors.push(error);
    return new Promise<void>(() => {});
  });
  app.route({
    method: "get",
    path: "/cleanup-pending",
    handler: async ({ services, ok }) => {
      await services.get(connection);
      return ok({ ok: true });
    },
  });
  await app.start();

  const started = Date.now();
  const response = await withinOneSecond(app.request("/cleanup-pending"));
  assert(Date.now() - started < 500);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
  assertEquals(errors.length, 1);
  assert(errors[0] instanceof AggregateError);
  assertEquals(errors[0].errors.map((error: Error) => error.message), ["close failed"]);
  await withinOneSecond(app.close());
});

Deno.test("request cleanup bounds stalled closers and returns the chosen response", async () => {
  const events: string[] = [];
  const errors: unknown[] = [];
  const app = createApp({
    config: { ...config, requestTimeoutMs: 80, shutdownTimeoutMs: 20 },
  });
  const later = app.requestService(() => ({
    close: () => void events.push("later"),
  }));
  const stalled = app.requestService(() => ({
    close: () => {
      events.push("stalled");
      return new Promise<void>(() => {});
    },
  }));
  app.addHook("onError", ({ error }) => {
    errors.push(error);
  });
  app.route({
    method: "get",
    path: "/stalled-cleanup",
    handler: async ({ services, ok }) => {
      await services.get(later);
      await services.get(stalled);
      return ok({ ok: true });
    },
  });
  await app.start();

  const response = await withinOneSecond(app.request("/stalled-cleanup"));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
  assertEquals(events, ["stalled", "later"]);
  assertEquals(errors.length, 1);
  assert(errors[0] instanceof AggregateError);
  assertEquals(errors[0].errors.map((error: Error) => error.name), ["TimeoutError"]);
  await withinOneSecond(app.close());
});

Deno.test("forced shutdown releases a request waiting on its service closer", async () => {
  const entered = Promise.withResolvers<void>();
  const app = createApp({
    config: { ...config, requestTimeoutMs: 5_000, shutdownTimeoutMs: 20 },
  });
  const stalled = app.requestService(() => ({
    close: () => {
      entered.resolve();
      return new Promise<void>(() => {});
    },
  }));
  app.route({
    method: "get",
    path: "/shutdown-cleanup",
    handler: async ({ services }) => {
      await services.get(stalled);
      return new Response("ok");
    },
  });
  await app.start();

  const pending = app.request("/shutdown-cleanup");
  await withinOneSecond(entered.promise);
  await withinOneSecond(app.close());
  const response = await withinOneSecond(pending);
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "ok");
});

Deno.test("app - handler SyntaxErrors are internal server errors", async () => {
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/syntax",
    handler: () => JSON.parse("{"),
  });
  await app.start();

  const response = await app.request("http://test/syntax");
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, "INTERNAL_ERROR");
});

Deno.test("app - raw Response results must use a declared status", async () => {
  const app = createApp({ config });
  const responses = { 200: Type.Object({ ok: Type.Boolean() }) };
  app.route({
    method: "get",
    path: "/raw-undeclared",
    responses,
    handler: () => new Response("accepted", { status: 202 }),
  });
  app.route({
    method: "get",
    path: "/raw-declared",
    responses,
    handler: () => Response.json({ ok: true }),
  });
  await app.start();

  const undeclared = await app.request("http://test/raw-undeclared");
  assertEquals(undeclared.status, 500);
  assertEquals((await undeclared.json()).code, "RESPONSE_CONTRACT_ERROR");

  const declared = await app.request("http://test/raw-declared");
  assertEquals(declared.status, 200);
  assertEquals(await declared.json(), { ok: true });
});

Deno.test("app - response bodies drop properties the schema does not declare", async () => {
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/users/me",
    responses: { 200: Type.Object({ id: Type.String(), name: Type.String() }) },
    handler: ({ ok }) => ok({ id: "u1", name: "Ada", passwordHash: "secret" }),
  });
  await app.start();

  const response = await app.request("http://test/users/me");
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { id: "u1", name: "Ada" });
});

Deno.test("header schemas match HTTP names regardless of case", async () => {
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/tenant",
    request: { headers: Type.Object({ "X-Tenant-Id": Type.String({ minLength: 3 }) }) },
    responses: { 200: Type.Object({ tenant: Type.String() }) },
    handler: ({ headers, ok }) => ok({ tenant: headers.get("X-Tenant-Id") }),
  });
  await app.start();

  const valid = await app.request("/tenant", { headers: { "x-tenant-id": "acme" } });
  assertEquals(valid.status, 200);
  assertEquals(await valid.json(), { tenant: "acme" });

  const invalid = await app.request("/tenant", { headers: { "X-Tenant-Id": "no" } });
  assertEquals(invalid.status, 400);
  assertEquals((await invalid.json()).details.source, "headers");
  await app.close();
});

Deno.test("header schemas reject case-colliding declared properties", () => {
  const app = createApp({ config });
  assertThrows(
    () =>
      app.route({
        method: "get",
        path: "/tenant",
        request: {
          headers: Type.Object({
            "X-Tenant-Id": Type.String(),
            "x-tenant-id": Type.String(),
          }),
        },
        handler: ({ ok }) => ok({ ok: true }),
      }),
    ConfigurationError,
    "X-Tenant-Id",
  );
});

Deno.test("required path parameter schema names must match registered path", async () => {
  const app = createApp({ config });
  app.group("/v1/{tenantId}", (group) => {
    assertThrows(
      () =>
        group.route({
          method: "get",
          path: "/orders/{orderId}",
          request: { params: Type.Object({ id: Type.String() }) },
          handler: ({ params, ok }) => ok({ id: params.id }),
        }),
      ConfigurationError,
      "GET /v1/{tenantId}/orders/{orderId}",
    );
    group.route({
      method: "get",
      path: "/orders/{orderId}",
      request: {
        params: Type.Object({ tenantId: Type.String(), orderId: Type.String() }),
      },
      handler: ({ params, ok }) => ok({ tenant: params.tenantId, id: params.orderId }),
    });
    group.route({
      method: "get",
      path: "/defaulted/{orderId}",
      request: {
        params: Type.Object({
          orderId: Type.String(),
          locale: Type.String({ default: "en" }),
        }),
      },
      handler: ({ params, ok }) => ok({ locale: params.locale }),
    });
    group.route({
      method: "get",
      path: "/untyped/{id}",
      handler: ({ ok }) => ok({ ok: true }),
    });
  });
  await app.start();
  assertEquals(await (await app.request("/v1/acme/orders/42")).json(), {
    tenant: "acme",
    id: "42",
  });
  assertEquals(await (await app.request("/v1/acme/untyped/42")).json(), { ok: true });
  assertEquals(await (await app.request("/v1/acme/defaulted/42")).json(), { locale: "en" });
  await app.close();
});

Deno.test("declared failure responses document JSON and thrown ProblemDetails", async () => {
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/resources/{id}",
    request: { params: Type.Object({ id: Type.String() }) },
    responses: {
      200: Type.Object({ id: Type.String() }),
      400: Type.Object({ issue: Type.String() }),
      404: Type.Object({ message: Type.String() }),
    },
    handler: ({ params, ok }) => {
      if (params.id === "missing") throw new NotFoundError();
      return ok({ id: params.id });
    },
  });
  await app.start();

  const document = await (await app.request("/openapi.json")).json();
  const responses = document.paths["/resources/{id}"].get.responses;
  for (const status of ["400", "404"]) {
    assert(responses[status].content["application/json"]);
    assertEquals(responses[status].content["application/problem+json"].schema, {
      $ref: "#/components/schemas/ProblemDetails",
    });
  }
  assertEquals(responses["200"].content["application/problem+json"], undefined);

  const missing = await app.request("/resources/missing");
  assertEquals(missing.status, 404);
  assertEquals(missing.headers.get("content-type"), "application/problem+json");
  assertEquals((await missing.json()).code, "NOT_FOUND");
  await app.close();
});

Deno.test("app - rejects GET bodies and OpenAPI path conflicts at registration", async () => {
  const app = createApp({ config });
  assertThrows(
    () =>
      app.route({
        method: "get",
        path: "/search",
        request: { body: Type.Object({ term: Type.String() }) },
        handler: () => undefined,
      }),
    ConfigurationError,
    "Route 'GET /search' cannot declare a request body.",
  );
  assertThrows(
    () =>
      app.route({
        method: "get",
        path: "/openapi.json",
        handler: () => undefined,
      }),
    ConfigurationError,
    "Route 'GET /openapi.json' conflicts with the OpenAPI document route.",
  );

  const withoutDocs = createApp({
    config: { ...config, openapi: { ...config.openapi, enabled: false } },
  });
  withoutDocs.route({
    method: "get",
    path: "/openapi.json",
    handler: ({ ok }) => ok({ custom: true }),
  });
  await withoutDocs.start();
  assertEquals(await (await withoutDocs.request("http://test/openapi.json")).json(), {
    custom: true,
  });
});

Deno.test("app - rejects requests whose upstream deadline has passed", async () => {
  let calls = 0;
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/late",
    handler: ({ ok }) => {
      calls += 1;
      return ok({ ok: true });
    },
  });
  await app.start();

  const response = await app.request("http://test/late", { headers: { "x-hyapi-deadline": "1" } });
  assertEquals(response.status, 504);
  assertEquals(response.headers.get("content-type"), "application/problem+json");
  assertEquals((await response.json()).code, "DEADLINE_EXCEEDED");
  assertEquals(calls, 0);
});

Deno.test("app - aborts ctx.signal and answers 503 when requestTimeoutMs elapses", async () => {
  const handlerFinished = Promise.withResolvers<boolean>();
  const app = await createApplication({
    config: defineConfig({ name: "t", requestTimeoutMs: 20 }),
    modules: [{
      name: "slow",
      setup(module) {
        module.route({
          method: "get",
          path: "/slow",
          handler: async ({ signal, ok }) => {
            const delay = Promise.withResolvers<void>();
            setTimeout(delay.resolve, 100);
            await delay.promise;
            handlerFinished.resolve(signal.aborted);
            return ok({ ok: true });
          },
        });
      },
    }],
  });

  const response = await app.request("http://test/slow");
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("content-type"), "application/problem+json");
  assertEquals((await response.json()).code, "REQUEST_TIMEOUT");
  assertEquals(await handlerFinished.promise, true);
  await app.close();
});

Deno.test("createApplication rejects invalid request limits", async () => {
  for (const requestTimeoutMs of [0, 2_147_483_648]) {
    await assertRejects(
      () =>
        createApplication({ config: defineConfig({ name: "t", requestTimeoutMs }), modules: [] }),
      ConfigurationError,
      "requestTimeoutMs must be a positive integer of at most 2147483647.",
    );
  }
  await assertRejects(
    () =>
      createApplication({ config: defineConfig({ name: "t", bodyLimitBytes: 0 }), modules: [] }),
    ConfigurationError,
    "bodyLimitBytes must be a positive integer.",
  );
});

Deno.test("withHttpContext propagates the effective deadline and request id header", async () => {
  let outgoing: Headers | undefined;
  let deadline: number | undefined;
  const app = createApp({ config: { ...config, requestIdHeader: "x-correlation-id" } });
  app.route({
    method: "get",
    path: "/propagate",
    handler: (context) => {
      deadline = context.deadline;
      outgoing = new Headers(withHttpContext(context, "svc").headers);
      return context.ok({ ok: true });
    },
  });
  await app.start();

  await app.request("http://test/propagate", { headers: { "x-correlation-id": "corr-1" } });
  assert(outgoing !== undefined);
  assertEquals(outgoing.get("x-hyapi-deadline"), String(deadline));
  assertEquals(outgoing.get("x-correlation-id"), "corr-1");
});

Deno.test("group hooks registered after a route still run for that route", async () => {
  const log: string[] = [];
  const app = createApp({ config });
  app.group("/late", (group) => {
    group.route({
      method: "get",
      path: "",
      handler: ({ ok }) => {
        log.push("handler");
        return ok({ ok: true });
      },
    });
    group.addHook("onRequest", () => {
      log.push("late:request");
    });
  });
  await app.start();

  assertEquals((await app.request("http://test/late")).status, 200);
  assertEquals(log, ["late:request", "handler"]);
});

Deno.test("app rejects hook, route, and auth provider registration after start", async () => {
  const app = createApp({ config });
  let captured: RouteGroupApi | undefined;
  app.group("/group", (group) => {
    captured = group;
  });
  await app.start();

  assertThrows(
    () => app.addHook("onRequest", () => undefined),
    ConfigurationError,
    "Cannot register hooks after the application has started.",
  );
  assertThrows(
    () => captured?.addHook("onRequest", () => undefined),
    ConfigurationError,
    "Cannot register hooks after the application has started.",
  );
  assertThrows(
    () => app.route({ method: "get", path: "/late", handler: () => undefined }),
    ConfigurationError,
    "Cannot register routes after the application has started.",
  );
  assertThrows(
    () => app.setAuthProvider({ authenticate: () => null }),
    ConfigurationError,
    "Cannot register an auth provider after the application has started.",
  );
});

Deno.test("group onError and onResponse hooks run when a handler fails", async () => {
  const log: string[] = [];
  const app = createApp({ config });
  app.addHook("onResponse", ({ response }) => {
    log.push(`global:response:${response?.status}`);
  });
  app.group("/api", (api) => {
    api.addHook("onError", () => {
      log.push("api:error");
    });
    api.addHook("onResponse", ({ response }) => {
      log.push(`api:response:${response?.status}`);
    });
    api.route({
      method: "get",
      path: "/fail",
      handler: () => {
        throw new Error("boom");
      },
    });
  });
  await app.start();

  const response = await app.request("http://test/api/fail");
  assertEquals(response.status, 500);
  assertEquals(log, ["api:error", "api:response:500", "global:response:500"]);
});

Deno.test("never-settling group onError preserves the selected 401 and notifies global once", async () => {
  const error = new AppError(401, "AUTH_REQUIRED", "Sign in required.");
  const observed: unknown[] = [];
  const responses: Array<{ status: number; code: string; error: unknown }> = [];
  const lateObserver = Promise.withResolvers<void>();
  const app = createApp({
    config: { ...config, requestTimeoutMs: 150, shutdownTimeoutMs: 20 },
  });
  app.group("/errors", (group) => {
    group.addHook("onError", (context) => {
      assertStrictEquals(context.error, error);
      return new Promise<void>(() => {});
    });
    group.route({
      method: "get",
      path: "/auth",
      handler: () => {
        throw error;
      },
    });
  });
  app.addHook("onError", ({ error: observedError }) => {
    observed.push(observedError);
    return lateObserver.promise;
  });
  app.addHook("onResponse", async ({ response, error: observedError }) => {
    const problem = await response!.clone().json();
    responses.push({ status: response!.status, code: problem.code, error: observedError });
  });
  await app.start();

  const response = await withinOneSecond(app.request("/errors/auth"));
  assertEquals(response.status, 401);
  assertEquals(response.headers.get("content-type"), "application/problem+json");
  assertEquals(response.headers.get("www-authenticate"), "Bearer");
  assertEquals((await response.json()).code, "AUTH_REQUIRED");
  assertEquals(observed, [error]);
  assertEquals(responses, [{ status: 401, code: "AUTH_REQUIRED", error }]);
  lateObserver.reject(new Error("late observer rejection"));
  await sleep(0);
  await withinOneSecond(app.close());
});

Deno.test("onError mutations do not hide the original failure from later observers", async () => {
  const error = new AppError(400, "INVALID_INPUT", "Invalid input.");
  const observed: unknown[] = [];
  const app = createApp({ config });
  app.group("/errors", (group) => {
    group.addHook("onError", async (context) => {
      observed.push(context.error);
      await Promise.resolve();
      context.error = null;
    });
    group.addHook("onError", (context) => {
      observed.push(context.error);
      context.error = null;
    });
    group.route({
      method: "get",
      path: "/bad",
      handler: () => {
        throw error;
      },
    });
  });
  app.addHook("onError", (context) => {
    observed.push(context.error);
    context.error = null;
  });
  app.addHook("onResponse", ({ error: observedError, response }) => {
    observed.push(observedError);
    assertEquals(response?.status, 400);
  });
  await app.start();

  const response = await app.request("/errors/bad");
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "INVALID_INPUT");
  assertEquals(observed, [error, error, error, error]);
  await app.close();
});

Deno.test("group and route scopes merge as a union", async () => {
  const app = createApp({ config });
  app.setAuthProvider({
    authenticate: (request) => {
      const scopes = request.headers.get("x-scopes");
      return scopes === null
        ? null
        : { subject: "user", scopes: scopes.split(",").filter(Boolean), claims: {} };
    },
  });
  app.group("/users", { auth: { scopes: ["users:read"] } }, (users) => {
    users.route({
      method: "post",
      path: "",
      auth: { scopes: ["users:write"] },
      handler: ({ created }) => created({ ok: true }),
    });
  });
  await app.start();

  const call = (scopes: string) =>
    app.request("http://test/users", { method: "POST", headers: { "x-scopes": scopes } });
  assertEquals((await call("users:read")).status, 403);
  assertEquals((await call("users:write")).status, 403);
  assertEquals((await call("users:read,users:write")).status, 201);
});

Deno.test("routes and groups cannot weaken inherited authentication", () => {
  const app = createApp({ config });
  app.group("/secure", { auth: { scopes: ["admin"] } }, (secure) => {
    assertThrows(
      () =>
        secure.route({
          method: "get",
          path: "/public",
          auth: false,
          handler: () => undefined,
        }),
      ConfigurationError,
      "Route 'GET /secure/public' cannot disable authentication inherited from its group.",
    );
    assertThrows(
      () =>
        secure.route({
          method: "get",
          path: "/optional",
          auth: { required: false },
          handler: () => undefined,
        }),
      ConfigurationError,
      "Route 'GET /secure/optional' cannot make inherited required authentication optional.",
    );
    assertThrows(
      () => secure.group("/open", { auth: false }, () => undefined),
      ConfigurationError,
      "Group '/secure/open' cannot disable authentication inherited from its group.",
    );
  });
});

Deno.test("singleton factories cannot resolve request-scoped services", async () => {
  const app = createApp({ config });
  const requestScoped = app.requestService(() => ({ id: 1 }));
  const leaky = app.singletonService(async (services) => await services.get(requestScoped));
  app.route({
    method: "get",
    path: "/leaky",
    handler: async ({ services, ok }) => ok(await services.get(leaky)),
  });
  await app.start();

  const response = await app.request("http://test/leaky");
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, "CONFIGURATION_ERROR");
});

Deno.test("failed singleton factories are retried on the next resolution", async () => {
  let attempts = 0;
  const app = createApp({ config });
  const flaky = app.singletonService(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("first attempt fails");
    return { attempts };
  });
  app.route({
    method: "get",
    path: "/flaky",
    handler: async ({ services, ok }) => ok(await services.get(flaky)),
  });
  await app.start();

  const failed = await app.request("http://test/flaky");
  assertEquals(failed.status, 500);
  await failed.body?.cancel();
  const recovered = await app.request("http://test/flaky");
  assertEquals(recovered.status, 200);
  assertEquals(await recovered.json(), { attempts: 2 });
  await app.close();
});

Deno.test("module.use rejects ports missing from requires", async () => {
  const port = definePort<{ value: string }>("undeclared.port");
  await assertRejects(
    () =>
      createApplication({
        config,
        providers: [providePort(port, { value: "x" })],
        modules: [{
          name: "sneaky",
          setup(module) {
            module.use(port);
          },
        }],
      }),
    ConfigurationError,
    "Module 'sneaky' uses port 'undeclared.port' without declaring it in requires.",
  );
});

Deno.test("createApplication rolls back providers and plugins when startup fails", async () => {
  const events: string[] = [];
  const failure = new Error("module start failed");
  const error = await assertRejects(() =>
    createApplication({
      config,
      providers: [providePort(definePort("rollback.port"), {}, {
        connect: () => {
          events.push("provider:connect");
        },
        close: () => {
          events.push("provider:close");
        },
      })],
      plugins: [{
        name: "tracker",
        setup: () => {
          events.push("plugin:setup");
        },
        onClose: () => {
          events.push("plugin:close");
        },
      }],
      modules: [{
        name: "broken",
        setup: () => undefined,
        onStart: () => {
          throw failure;
        },
        onClose: () => {
          events.push("module:close");
        },
      }],
    })
  );
  assertStrictEquals(error, failure);
  assertEquals(events, [
    "plugin:setup",
    "provider:connect",
    "module:close",
    "plugin:close",
    "provider:close",
  ]);
});

Deno.test("providers close in reverse registration order", async () => {
  const events: string[] = [];
  const closing = (name: string) => ({
    close: () => {
      events.push(name);
    },
  });
  const app = await createApplication({
    config,
    modules: [],
    providers: [
      providePort(definePort("a"), {}, closing("a")),
      providePort(definePort("b"), {}, closing("b")),
      providePort(definePort("c"), {}, closing("c")),
    ],
  });
  await app.close();
  assertEquals(events, ["c", "b", "a"]);
});

Deno.test("health aggregates degraded providers and rejects invalid reports", async () => {
  const app = await createApplication({
    config,
    modules: [],
    providers: [
      providePort(definePort("ok"), {}, { health: () => ({ status: "healthy", provider: "ok" }) }),
      providePort(definePort("slow"), {}, {
        health: () => ({ status: "degraded", provider: "slow", detail: "lagging" }),
      }),
      providePort(definePort("plain"), {}),
    ],
  });
  assertEquals(await app.health(), {
    status: "degraded",
    providers: [
      { status: "healthy", provider: "ok" },
      { status: "degraded", provider: "slow", detail: "lagging" },
      { status: "healthy", provider: "plain" },
    ],
  });
  await app.close();

  const invalid = await createApplication({
    config,
    modules: [],
    providers: [providePort(definePort("bogus"), {}, {
      health: () => ({ status: "fine", provider: "bogus" }) as unknown as ProviderHealth,
    })],
  });
  assertEquals(await invalid.health(), {
    status: "unhealthy",
    providers: [{
      status: "unhealthy",
      provider: "bogus",
      detail: "Health check returned an invalid report.",
    }],
  });
  await invalid.close();
});

Deno.test("health reports providers whose checks time out as unhealthy", async () => {
  const app = await createApplication({
    config,
    modules: [],
    providers: [providePort(definePort("hung"), {}, {
      health: () => Promise.withResolvers<ProviderHealth>().promise,
    })],
  });
  assertEquals(await app.health(), {
    status: "unhealthy",
    providers: [{
      status: "unhealthy",
      provider: "hung",
      detail: "Health check timed out after 5000 ms.",
    }],
  });
  await app.close();
});

Deno.test("plugins receive only the platform API", async () => {
  let platform: unknown;
  const app = await createApplication({
    config,
    modules: [],
    plugins: [{
      name: "inspect",
      setup: (value) => {
        platform = value;
      },
    }],
  });
  assert(typeof platform === "object" && platform !== null);
  assertEquals("route" in platform, false);
  assertEquals("http" in platform, false);
  assertEquals(Object.keys(platform).sort(), ["addHook", "setAuthProvider"]);
  assert(Object.isFrozen(platform));
  await app.close();
});

Deno.test("requests after close return 503 and never reuse closed singletons", async () => {
  const log: string[] = [];
  const app = await createApplication({
    config,
    modules: [{
      name: "db",
      setup(module) {
        const db = module.singleton(() => {
          log.push("create");
          return { close: () => void log.push("close") };
        });
        module.route({
          method: "get",
          path: "/db",
          handler: async ({ services }) => {
            await services.get(db);
            return new Response(null, { status: 204 });
          },
        });
      },
    }],
  });
  assertEquals((await app.request("http://test/db")).status, 204);
  await app.close();

  const response = await app.request("http://test/db");
  assertEquals(response.status, 503);
  assert(response.headers.get("x-request-id"));
  assertEquals((await response.json()).code, "APPLICATION_UNAVAILABLE");
  assertEquals(log, ["create", "close"]);
});

Deno.test("request services outliving their request are closed and never created late", async () => {
  const log: string[] = [];
  const outcomes = Promise.withResolvers<unknown[]>();
  const app = createApp({ config: { ...config, requestTimeoutMs: 20 } });
  const connection = app.requestService(async () => {
    await sleep(60);
    log.push("request:create");
    return { close: () => void log.push("request:close") };
  });
  const code = (error: unknown) => error instanceof AppError ? error.code : error;
  app.route({
    method: "get",
    path: "/slow",
    handler: async ({ services }) => {
      // Started before the timeout, finished after the request scope closed.
      const inFlight = await services.get(connection).then(() => "resolved", code);
      // Started after the request scope closed.
      const late = await services.get(connection).then(() => "resolved", code);
      outcomes.resolve([inFlight, late]);
      return new Response(null, { status: 204 });
    },
  });
  await app.start();

  const response = await app.request("http://test/slow");
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "REQUEST_TIMEOUT");
  assertEquals(await withinOneSecond(outcomes.promise), ["SCOPE_CLOSED", "SCOPE_CLOSED"]);
  assertEquals(log, ["request:create", "request:close"]);
  await app.close();
});

Deno.test("close drains in-flight requests before closing providers", async () => {
  const log: string[] = [];
  const port = definePort<{ query(): string }>("drain.db");
  const app = await createApplication({
    config,
    providers: [providePort(port, { query: () => "row" }, {
      close: () => void log.push("provider:close"),
    })],
    modules: [{
      name: "work",
      requires: [port],
      setup(module) {
        const db = module.use(port);
        module.route({
          method: "get",
          path: "/work",
          handler: async () => {
            log.push("handler:start");
            await sleep(50);
            log.push(`handler:use:${db.query()}`);
            return new Response(null, { status: 204 });
          },
        });
      },
    }],
  });

  const inflight = app.request("http://test/work");
  await sleep(5);
  await withinOneSecond(app.close());
  log.push("close:resolved");
  assertEquals((await inflight).status, 204);
  assertEquals(log, ["handler:start", "handler:use:row", "provider:close", "close:resolved"]);
});

Deno.test("close aborts requests that outlive shutdownTimeoutMs", async () => {
  let observed = false;
  const app = await createApplication({
    config: { ...config, shutdownTimeoutMs: 20 },
    modules: [{
      name: "stuck",
      setup(module) {
        module.route({
          method: "get",
          path: "/stuck",
          handler: async ({ signal }) => {
            const aborted = Promise.withResolvers<void>();
            signal.addEventListener("abort", () => aborted.resolve(), { once: true });
            await aborted.promise;
            observed = signal.aborted;
            return new Response(null, { status: 204 });
          },
        });
      },
    }],
  });

  const inflight = app.request("http://test/stuck");
  await sleep(5);
  await withinOneSecond(app.close());
  const response = await withinOneSecond(Promise.resolve(inflight));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "APPLICATION_UNAVAILABLE");
  assertEquals(observed, true);
});

Deno.test("requestTimeoutMs bounds global onRequest hooks", async () => {
  const app = createApp({ config: { ...config, requestTimeoutMs: 20 } });
  app.addHook("onRequest", () => sleep(150));
  app.route({
    method: "get",
    path: "/hooked",
    handler: () => new Response(null, { status: 204 }),
  });
  await app.start();

  const started = Date.now();
  const response = await app.request("http://test/hooked");
  assert(Date.now() - started < 100);
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "REQUEST_TIMEOUT");
  await app.close();
});

Deno.test("health reports unhealthy without probing providers after close", async () => {
  let probes = 0;
  const app = await createApplication({
    config,
    modules: [],
    providers: [providePort(definePort("probed"), {}, {
      health: () => {
        probes += 1;
        return { status: "healthy", provider: "probed" };
      },
    })],
  });
  assertEquals((await app.health()).status, "healthy");
  await app.close();

  assertEquals(await app.health(), { status: "unhealthy", providers: [] });
  assertEquals(probes, 1);
});

Deno.test("a failing onResponse hook still lets outer hooks see the error response", async () => {
  const statuses: number[] = [];
  const app = createApp({ config });
  app.addHook("onResponse", () => {
    throw new Error("hook failed");
  });
  app.addHook("onResponse", ({ response }) => {
    statuses.push(response?.status ?? 0);
  });
  app.route({ method: "get", path: "/ok", handler: () => new Response("ok") });
  await app.start();

  const response = await app.request("http://test/ok");
  assertEquals(response.status, 500);
  assertEquals(response.headers.get("content-type"), "application/problem+json");
  await response.body?.cancel();
  assertEquals(statuses, [500]);
  await app.close();
});

Deno.test("timed-out group onResponse does not commit 200 or re-notify its failure", async () => {
  const events: string[] = [];
  const errors: unknown[] = [];
  const app = createApp({
    config: { ...config, requestTimeoutMs: 80, shutdownTimeoutMs: 20 },
  });
  app.group("/response-hooks", (group) => {
    group.addHook("onResponse", () => {
      events.push("group:pending");
      return new Promise<void>(() => {});
    });
    group.addHook("onResponse", ({ response }) => {
      events.push(`group:outer:${response?.status}`);
    });
    group.route({
      method: "get",
      path: "/timeout",
      handler: () => new Response("ok"),
    });
  });
  app.addHook("onError", ({ error }) => {
    errors.push(error);
  });
  app.addHook("onResponse", ({ response }) => {
    events.push(`global:outer:${response?.status}`);
  });
  await app.start();

  const response = await withinOneSecond(app.request("/response-hooks/timeout"));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "REQUEST_TIMEOUT");
  assertEquals(events, ["group:pending", "group:outer:503", "global:outer:503"]);
  assertEquals(errors.length, 1);
  assert(errors[0] instanceof AppError);
  assertEquals(errors[0].code, "REQUEST_TIMEOUT");
  await withinOneSecond(app.close());
});

Deno.test("late onResponse completion cannot return a stale 200", async () => {
  const app = createApp({
    config: { ...config, requestTimeoutMs: 60, shutdownTimeoutMs: 20 },
  });
  app.addHook("onResponse", async () => {
    await sleep(120);
  });
  app.route({
    method: "get",
    path: "/late-response",
    handler: () => new Response("stale"),
  });
  await app.start();

  const response = await withinOneSecond(app.request("/late-response"));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "REQUEST_TIMEOUT");
  await withinOneSecond(app.close());
});

Deno.test("upstream deadline bounds onResponse with a 504 problem", async () => {
  const observed: number[] = [];
  const app = createApp({
    config: { ...config, requestTimeoutMs: 1_000, shutdownTimeoutMs: 20 },
  });
  app.addHook("onResponse", () => new Promise<void>(() => {}));
  app.addHook("onResponse", ({ response }) => {
    observed.push(response!.status);
  });
  app.route({
    method: "get",
    path: "/upstream-response",
    handler: () => new Response("stale"),
  });
  await app.start();

  const response = await withinOneSecond(app.request("/upstream-response", {
    headers: { "x-hyapi-deadline": String(Date.now() + 150) },
  }));
  assertEquals(response.status, 504);
  assertEquals((await response.json()).code, "DEADLINE_EXCEEDED");
  assertEquals(observed, [504]);
  await withinOneSecond(app.close());
});

Deno.test("app.close releases stalled onResponse with a forced 503", async () => {
  const entered = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  const app = createApp({
    config: { ...config, requestTimeoutMs: 5_000, shutdownTimeoutMs: 20 },
  });
  app.addHook("onResponse", () => {
    entered.resolve();
    return new Promise<void>(() => {});
  });
  app.addHook("onError", ({ error }) => {
    errors.push(error);
  });
  app.route({
    method: "get",
    path: "/shutdown-response",
    handler: () => new Response("stale"),
  });
  await app.start();

  const pending = app.request("/shutdown-response");
  await withinOneSecond(entered.promise);
  await withinOneSecond(app.close());
  const response = await withinOneSecond(pending);
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "APPLICATION_UNAVAILABLE");
  assertEquals(errors.length, 1);
});

Deno.test("ctx.signal aborts when the client disconnects", async () => {
  const observed = Promise.withResolvers<boolean>();
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/watch",
    handler: async ({ signal }) => {
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
      observed.resolve(signal.aborted);
      return new Response(null, { status: 204 });
    },
  });
  await app.start();

  const client = new AbortController();
  const pending = app.request("http://test/watch", { signal: client.signal });
  await sleep(10);
  client.abort();
  assertEquals(await withinOneSecond(observed.promise), true);
  await (await withinOneSecond(pending)).body?.cancel();
  await app.close();
});

Deno.test("createApplication rejects invalid shutdown timeouts", async () => {
  for (const shutdownTimeoutMs of [0, 2_147_483_648]) {
    await assertRejects(
      () =>
        createApplication({ config: defineConfig({ name: "t", shutdownTimeoutMs }), modules: [] }),
      ConfigurationError,
      "shutdownTimeoutMs must be a positive integer of at most 2147483647.",
    );
  }
});

Deno.test("unmatched route bypasses onError and relative requests keep localhost origin", async () => {
  const errors: unknown[] = [];
  const statuses: number[] = [];
  const urls: string[] = [];
  const app = createApp({ config });
  app.addHook("onError", ({ error }) => {
    errors.push(error);
  });
  app.addHook("onResponse", ({ response }) => {
    statuses.push(response!.status);
  });
  app.addHook("onRequest", ({ request }) => {
    urls.push(request.url);
  });
  await app.start();
  for (
    const input of [
      "//other/x",
      "items:batch",
      new URL("http://elsewhere/x"),
      new Request("http://other/x"),
    ]
  ) {
    assertEquals((await app.request(input)).status, 404);
  }
  assertEquals(errors, []);
  assertEquals(statuses, [404, 404, 404, 404]);
  assertEquals(urls, [
    "http://localhost//other/x",
    "http://localhost/items:batch",
    "http://elsewhere/x",
    "http://other/x",
  ]);
  await app.close();
});

Deno.test("discarded responses cannot stall failure or leak headers", async () => {
  const statuses: number[] = [];
  const errors: unknown[] = [];
  const app = createApp({ config });
  app.addHook("onResponse", ({ response }) => {
    if (response?.status === 302) throw new Error("hook failed");
    statuses.push(response!.status);
  });
  app.addHook("onError", ({ error }) => {
    errors.push(error);
  });
  app.route({
    method: "get",
    path: "/discard",
    handler: () =>
      new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), {
        status: 302,
        headers: { location: "/old" },
      }),
  });
  app.route({
    method: "get",
    path: "/contract",
    responses: { 200: Type.String() },
    handler: () =>
      new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), {
        status: 302,
      }),
  });
  await app.start();
  for (const path of ["/discard", "/contract"]) {
    const response = await withinOneSecond(app.request(path));
    assertEquals(response.status, 500);
    assertEquals(
      (await response.json()).code,
      path === "/discard" ? "INTERNAL_ERROR" : "RESPONSE_CONTRACT_ERROR",
    );
    assertEquals(response.headers.get("location"), null);
    assert(response.headers.has("x-request-id"));
  }
  assertEquals(statuses, [500]);
  assertEquals(errors.length, 2);
  await app.close();
});

Deno.test("nonconstructible Response.error is converted once without rerunning response hooks", async () => {
  const statuses: number[] = [];
  const errors: unknown[] = [];
  const app = createApp({ config });
  app.addHook("onResponse", ({ response }) => {
    statuses.push(response!.status);
  });
  app.addHook("onError", ({ error }) => {
    errors.push(error);
  });
  app.route({ method: "get", path: "/error", handler: () => Response.error() });
  await app.start();
  const response = await app.request("/error", { headers: { "x-request-id": "trace-1" } });
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, "INTERNAL_ERROR");
  assertEquals(response.headers.get("x-request-id"), "trace-1");
  assertEquals(statuses, [0]);
  assertEquals(errors.length, 1);
  await app.close();
});

Deno.test("schema body is independently readable by handler and error hook", async () => {
  let handlerBody = "";
  let errorBody = "";
  const app = createApp({ config });
  app.addHook("onError", async ({ request }) => {
    errorBody = await request.clone().text();
  });
  app.route({
    method: "post",
    path: "/replay",
    request: { body: Type.Object({ n: Type.Number() }) },
    handler: async ({ request }) => {
      handlerBody = await request.text();
      throw new Error("handler failed");
    },
  });
  await app.start();
  const response = await app.request("/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"n":1}',
  });
  assertEquals((await response.json()).code, "INTERNAL_ERROR");
  assertEquals(handlerBody, '{"n":1}');
  assertEquals(errorBody, '{"n":1}');
  await app.close();
});

Deno.test("client disconnect is forwarded only while the request scope is active", async () => {
  let savedSignal: AbortSignal | undefined;
  const app = createApp({ config });
  app.route({
    method: "get",
    path: "/signal",
    handler: ({ signal }) => {
      savedSignal = signal;
      return new Response("ok");
    },
  });
  await app.start();
  const client = new AbortController();
  const response = await app.request(new Request("http://test/signal", { signal: client.signal }));
  assertEquals(await response.text(), "ok");
  client.abort();
  assertEquals(savedSignal?.aborted, false);
  await app.close();
});

Deno.test("lazy response stream owns its payload after request service cleanup", async () => {
  const events: string[] = [];
  const app = createApp({ config });
  const service = app.requestService(() => ({
    close: () => {
      events.push("service:close");
    },
  }));
  app.route({
    method: "get",
    path: "/stream",
    handler: async ({ services }) => {
      await services.get(service);
      return new Response(
        new ReadableStream({
          pull(controller) {
            events.push("stream:pull");
            controller.enqueue(new TextEncoder().encode("independent"));
            controller.close();
          },
        }, { highWaterMark: 0 }),
      );
    },
  });
  await app.start();
  const response = await app.request("/stream");
  assertEquals(events, ["service:close"]);
  assertEquals(await response.text(), "independent");
  assertEquals(events, ["service:close", "stream:pull"]);
  await app.close();
});

Deno.test("forced shutdown gives cooperative request cleanup precedence over providers", async () => {
  const log: string[] = [];
  const started = Promise.withResolvers<void>();
  const port = definePort("cooperative.port");
  const app = createApp({
    config: { ...config, shutdownTimeoutMs: 20 },
    providers: [providePort(port, {}, {
      close: () => {
        log.push("provider:close");
      },
    })],
  });
  const service = app.requestService(() => ({
    close: () => {
      log.push("request-service:close");
    },
  }));
  app.route({
    method: "get",
    path: "/cooperative",
    handler: async ({ services, signal }) => {
      await services.get(service);
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      await aborted.promise;
      return new Response(null, { status: 204 });
    },
  });
  await app.start();
  const request = app.request("/cooperative");
  await started.promise;
  await withinOneSecond(app.close());
  assertEquals((await request).status, 503);
  assertEquals(log, ["request-service:close", "provider:close"]);
});

Deno.test("uncooperative handler and closer cannot hold running app shutdown indefinitely", async () => {
  const started = Promise.withResolvers<void>();
  const app = createApp({
    config: { ...config, shutdownTimeoutMs: 20 },
    providers: [providePort(definePort("stalled.close"), {}, {
      close: () => new Promise<void>(() => {}),
    })],
  });
  app.route({
    method: "get",
    path: "/uncooperative",
    handler: async () => {
      started.resolve();
      await new Promise<void>(() => {});
    },
  });
  await app.start();
  void app.request("/uncooperative");
  await started.promise;
  const failure = await assertRejects(() => withinOneSecond(app.close()), AggregateError);
  assertEquals(failure.errors.map((error: Error) => error.name), ["TimeoutError"]);
  assertEquals((await app.request("/uncooperative")).status, 503);
});

Deno.test("provider connection rollback respects the cleanup deadline and preserves the setup error", async () => {
  const connectFailure = new Error("connection failed");
  const error = await assertRejects(() =>
    createApplication({
      config: { ...config, shutdownTimeoutMs: 20 },
      modules: [],
      providers: [
        providePort(definePort("connected"), {}, {
          connect: () => undefined,
          close: () => new Promise<void>(() => {}),
        }),
        providePort(definePort("broken"), {}, {
          connect: () => {
            throw connectFailure;
          },
        }),
      ],
    }), AggregateError);
  assertStrictEquals(error.errors[0], connectFailure);
  assertEquals(error.errors[1].name, "TimeoutError");
});
