import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type AppConfig,
  type AuthProvider,
  createApplication,
  createTestApplication,
  defineConfig,
  defineModule,
  definePlugin,
  definePort,
  definePortContract,
  defineRoute,
  type Identity,
  providePort,
  provideValue,
  verifyPortContract,
  verifyPortContracts,
} from "../mod.ts";
import { expectStatus, requestJson } from "../mod.ts";
import { ConfigurationError } from "../mod.ts";
import { createApp } from "./app.ts";
import Type from "typebox";

const config: AppConfig = {
  name: "core-test",
  version: "0.1.0",
  environment: "test",
  requestIdHeader: "x-request-id",
  openapi: {
    title: "Core test API",
    version: "0.1.0",
    path: "/openapi.json",
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
    defineRoute({
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
    }),
  );
  await app.ready();

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

Deno.test("request context accepts valid deadlines and ignores empty headers", async () => {
  let deadline: number | undefined;
  const app = createApp({ config });
  app.route(defineRoute({
    method: "get",
    path: "/deadline",
    handler: ({ deadline: value, ok }) => {
      deadline = value;
      return ok({ ok: true });
    },
  }));
  await app.ready();

  await app.request("http://test/deadline", { headers: { "x-hyapi-deadline": "123" } });
  assertEquals(deadline, 123);
  await app.request("http://test/deadline", { headers: { "x-hyapi-deadline": "" } });
  assertEquals(deadline, undefined);
});

Deno.test("defineConfig provides ergonomic application defaults", () => {
  assertEquals(defineConfig({ name: "orders" }), {
    name: "orders",
    version: "0.1.0",
    environment: "development",
    requestIdHeader: "x-request-id",
    openapi: { title: "orders API", version: "0.1.0", path: "/openapi.json" },
  });
});

Deno.test("unmatched routes return problem details", async () => {
  const app = createApp({ config });
  await app.ready();
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
      definePlugin({
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
      }),
    ],
    modules: [
      defineModule({
        name: "dependent",
        dependencies: ["base"],
        setup: (module) => {
          log.push("module:dependent");
          module.route(defineRoute({
            method: "get",
            path: "/modules",
            handler: ({ ok }) => ok({ ok: true }),
          }));
        },
        onStart: () => {
          log.push("module:dependent:start");
        },
        onClose: () => {
          log.push("module:dependent:close");
        },
      }),
      defineModule({
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
      }),
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
          defineModule({ name: "orders", dependencies: ["users"], setup: () => undefined }),
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
        plugins: [definePlugin({ name: "a", dependencies: ["b"], setup: () => undefined })],
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
    modules: [defineModule({
      name: "services",
      setup(module) {
        const singleton = module.singleton(() => ({ id: ++nextId, close: () => closed.push(1) }));
        const request = module.request(() => ({ id: ++nextId, close: () => closed.push(2) }));
        const transient = module.transient(() => ({ id: ++nextId }));
        module.route(defineRoute({
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
        }));
      },
    })],
  });

  const first = await (await app.request("http://test/services")).json();
  const second = await (await app.request("http://test/services")).json();
  assertEquals(first, { singleton: 1, request: [2, 2], transient: [3, 4] });
  assertEquals(second, { singleton: 1, request: [5, 5], transient: [6, 7] });
  assertEquals(closed, [2, 2]);
  await app.close();
  assertEquals(closed, [2, 2, 1]);
});

Deno.test("createTestApplication replaces named services before module setup is used", async () => {
  let factoryCalls = 0;
  const app = await createTestApplication({
    config,
    overrides: [provideValue("clock", { now: () => "test-time" })],
    modules: [defineModule({
      name: "clock",
      setup(module) {
        const clock = module.singleton("clock", () => {
          factoryCalls += 1;
          return { now: () => "production-time" };
        });
        module.route(defineRoute({
          method: "get",
          path: "/clock",
          handler: async ({ services, ok }) => ok({ now: (await services.get(clock)).now() }),
        }));
      },
    })],
  });

  assertEquals(await (await app.request("http://test/clock")).json(), { now: "test-time" });
  assertEquals(factoryCalls, 0);
});

Deno.test("modules resolve explicit ports and reject missing or incompatible providers", async () => {
  const userDirectory = definePort<{ find(id: string): string }>("users.directory");
  const app = await createApplication({
    config,
    providers: [providePort(userDirectory, { find: (id) => `user:${id}` })],
    modules: [defineModule({
      name: "orders",
      requires: [userDirectory],
      setup(module) {
        const users = module.use(userDirectory);
        module.route(defineRoute({
          method: "get",
          path: "/orders/{id}",
          request: { params: Type.Object({ id: Type.String() }) },
          handler: ({ params, ok }) => ok({ owner: users.find(params.id) }),
        }));
      },
    })],
  });
  assertEquals(await (await app.request("http://test/orders/1")).json(), { owner: "user:1" });

  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [
          defineModule({ name: "missing", requires: [userDirectory], setup: () => undefined }),
        ],
      }),
    ConfigurationError,
    "users.directory",
  );
  await assertRejects(
    () =>
      createApplication({
        config,
        providers: [providePort(definePort("users.directory", 2), { find: () => "" })],
        modules: [
          defineModule({ name: "version", requires: [userDirectory], setup: () => undefined }),
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
    modules: [defineModule({
      name: "consumer",
      requires: [port],
      setup: (module) => {
        assertEquals(module.use(port).value, "ok");
      },
    })],
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
  const first = definePort("first", 1);
  const second = definePort("second", 1);
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

Deno.test("provider minor versions are compatible within the same major", async () => {
  const required = definePort<{ value: string }>("versioned.port", { major: 1, minor: 1 });
  const provided = definePort<{ value: string }>("versioned.port", { major: 1, minor: 2 });
  const app = await createApplication({
    config,
    modules: [defineModule({ name: "consumer", requires: [required], setup: () => undefined })],
    providers: [providePort(provided, { value: "ok" })],
  });
  await app.close();
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [defineModule({ name: "consumer", requires: [required], setup: () => undefined })],
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
  const pluginA = definePlugin({
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
  });
  const pluginB = definePlugin({
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
  });
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
    plugins: [definePlugin({
      name: "slow-plugin",
      setup: async () => {
        setupCount += 1;
        await Promise.resolve();
      },
    })],
  });
  assertEquals(setupCount, 1);
  await app.close();
});

Deno.test("circular plugin dependencies throw ConfigurationError", async () => {
  const p1 = definePlugin({ name: "p1", dependencies: ["p2"], setup: () => undefined });
  const p2 = definePlugin({ name: "p2", dependencies: ["p1"], setup: () => undefined });
  await assertRejects(
    () => createApplication({ config, modules: [], plugins: [p1, p2] }),
    ConfigurationError,
  );
});

Deno.test("missing plugin dependencies throw ConfigurationError", async () => {
  const p1 = definePlugin({ name: "p1", dependencies: ["missingDep"], setup: () => undefined });
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
        defineRoute({
          method: "get",
          path: "",
          responses: { 200: Type.Object({ status: Type.String() }) },
          handler: ({ ok }) => ok({ status: "all-users" }),
        }),
      );
      users.route(
        defineRoute({
          method: "get",
          path: "/{id}",
          request: { params: Type.Object({ id: Type.String() }) },
          responses: { 200: Type.Object({ id: Type.String() }) },
          handler: ({ params, ok }) => ok({ id: params.id }),
        }),
      );
      users.group({ auth: { scopes: ["users:write"] } }, (writers) => {
        writers.route(
          defineRoute({
            method: "post",
            path: "",
            responses: { 201: Type.Object({ created: Type.Boolean() }) },
            handler: ({ created }) => created({ created: true }),
          }),
        );
      });
    });
  });

  await app.ready();

  const openapiRes = await app.request("http://test/openapi.json");
  const doc = await openapiRes.json();
  assert(doc.paths["/v1/users"]);
  assert(doc.paths["/v1/users/{id}"]);
  assertEquals(doc.paths["/v1/users"].get.tags, ["Users"]);
  assertEquals(doc.paths["/v1/users"].get.security, [{ bearerAuth: ["users:read"] }]);
  assertEquals(doc.paths["/v1/users"].post.security, [{ bearerAuth: ["users:write"] }]);
  assert(doc.paths["/v1/users"].get.responses["401"]);
  assert(doc.paths["/v1/users"].get.responses["403"]);

  const resWithoutAuth = await app.request("http://test/v1/users");
  assertEquals(resWithoutAuth.status, 401);

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
  app.route(defineRoute({
    method: "get",
    path: "/private",
    auth: {},
    handler: () => "private",
  }));
  await assertRejects(() => app.ready(), ConfigurationError);
});

Deno.test("multi-status response schema validates matching status code schema", async () => {
  const app = createApp({ config });
  app.route(
    defineRoute({
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
    }),
  );
  await app.ready();

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
    defineRoute({
      method: "get",
      path: "/undeclared-status",
      responses: { 200: responseSchema },
      handler: ({ json }) => json({ ok: true }, 202),
    }),
  );
  app.route(
    defineRoute({
      method: "get",
      path: "/missing-response-body",
      responses: { 200: responseSchema },
      handler: () => undefined,
    }),
  );

  await app.ready();

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
    defineRoute({
      method: "get",
      path: "/composite-response",
      responses: { 200: Type.Union([Type.String(), Type.Number()]) },
      handler: () => true,
    }),
  );
  await app.ready();

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
    defineRoute({
      method: "get",
      path: "/tags",
      request: {
        query: Type.Object({ tag: Type.Array(Type.String()) }),
      },
      responses: {
        200: Type.Object({ tags: Type.Array(Type.String()) }),
      },
      handler: ({ query, ok }) => ok({ tags: query.tag }),
    }),
  );
  await app.ready();

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
    defineRoute({
      method: "get",
      path: "/public",
      responses: { 200: Type.Object({ ok: Type.Boolean() }) },
      handler: ({ ok }) => {
        log.push("handler:public");
        return ok({ ok: true });
      },
    }),
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
        defineRoute({
          method: "get",
          path: "",
          responses: { 200: Type.Object({ ok: Type.Boolean() }) },
          handler: ({ ok }) => {
            log.push("handler:users");
            return ok({ ok: true });
          },
        }),
      );
    });
  });

  await app.ready();

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
    "api:response",
    "users:response",
    "global:response",
  ]);
});

Deno.test("TypeCompiler validates formats and coerces query params", async () => {
  const app = createApp({ config });
  app.route(
    defineRoute({
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
    }),
  );
  await app.ready();

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
    defineRoute({
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
    }),
  );

  await app.ready();

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
    defineRoute({
      method: "post",
      path: "/required-body",
      request: { body: bodySchema },
      responses: { 200: Type.Object({ name: Type.String(), rawBody: Type.String() }) },
      handler: async ({ body, request, ok }) => {
        const rawBody = await request.text();
        return ok({ ...body, rawBody: JSON.parse(rawBody).name });
      },
    }),
  );
  app.route(
    defineRoute({
      method: "post",
      path: "/optional-body",
      request: { body: bodySchema, bodyRequired: false },
      responses: { 200: Type.Object({ present: Type.Boolean() }) },
      handler: ({ body, ok }) => ok({ present: body !== undefined }),
    }),
  );
  app.route(
    defineRoute({
      method: "post",
      path: "/no-body-schema",
      responses: { 200: Type.Object({ bodyWasParsed: Type.Boolean() }) },
      handler: ({ body, ok }) => ok({ bodyWasParsed: body !== undefined }),
    }),
  );

  await app.ready();

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
    defineRoute({
      method: "post",
      path: "/unsupported-body",
      request: { body: Type.Object({ name: Type.String() }) },
      handler: ({ ok }) => ok({ accepted: true }),
    }),
  );
  await app.ready();

  const response = await app.request("http://test/unsupported-body", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "not-json",
  });
  assertEquals(response.status, 415);
  assertEquals((await response.json()).code, "UNSUPPORTED_MEDIA_TYPE");
});

Deno.test("app - rejects duplicate routes", () => {
  const app = createApp({ config });
  const dummyRoute = defineRoute({
    method: "get",
    path: "/items",
    handler: () => "items",
  });

  app.route(dummyRoute);
  assertThrows(() => app.route(dummyRoute), ConfigurationError);
});

Deno.test("app - shares request state across hooks and handler", async () => {
  const app = createApp({ config });
  app.addHook("onRequest", ({ state }) => {
    state.set("userRole", "superadmin");
  });

  app.route(
    defineRoute({
      method: "get",
      path: "/state-test",
      responses: { 200: Type.Object({ role: Type.String() }) },
      handler: ({ state, ok }) => {
        return ok({ role: state.get("userRole") as string });
      },
    }),
  );
  await app.ready();

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
    defineRoute({
      method: "get",
      path: "/fail",
      handler: () => {
        throw new Error("Explicit handler failure");
      },
    }),
  );
  await app.ready();

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
    defineRoute({
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
    }),
  );
  await app.ready();

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
    defineRoute({
      method: "get",
      path: "/raw-response",
      handler: () => new Response("custom stream or raw body", { status: 202 }),
    }),
  );
  await app.ready();

  const res = await app.request("http://test/raw-response");
  assertEquals(res.status, 202);
  assertEquals(await res.text(), "custom stream or raw body");
});
