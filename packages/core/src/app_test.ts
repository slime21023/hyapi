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
  createApp,
  defineRoute,
  type Identity,
  type Plugin,
} from "../mod.ts";
import { ConfigurationError } from "../mod.ts";
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

  const invalid = await app.request("http://test/items/a?limit=0");
  assertEquals(invalid.status, 400);
  const problem = await invalid.json();
  assertEquals(problem.code, "VALIDATION_ERROR");
  assertEquals(invalid.headers.get("content-type"), "application/problem+json");
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

Deno.test("plugins sort topologically, execute onStart and onClose in reverse", async () => {
  const app = createApp({ config });
  const log: string[] = [];

  const pluginA: Plugin = {
    name: "pluginA",
    dependencies: ["pluginB"],
    register: () => {
      log.push("register:A");
    },
    onStart: () => {
      log.push("start:A");
    },
    onClose: () => {
      log.push("close:A");
    },
  };

  const pluginB: Plugin = {
    name: "pluginB",
    register: () => {
      log.push("register:B");
    },
    onStart: () => {
      log.push("start:B");
    },
    onClose: () => {
      log.push("close:B");
    },
  };

  // Register out of order: A before B
  await app.register(pluginA, {});
  await app.register(pluginB, {});
  await assertRejects(() => app.register(pluginA, {}), ConfigurationError);

  await app.ready();
  assertEquals(log, ["register:B", "register:A", "start:B", "start:A"]);

  await app.close();
  await app.close();
  assertEquals(log, [
    "register:B",
    "register:A",
    "start:B",
    "start:A",
    "close:A",
    "close:B",
  ]);
});

Deno.test("app - serializes concurrent ready calls and rejects late plugins", async () => {
  const app = createApp({ config });
  let registerCount = 0;
  await app.register({
    name: "slow-plugin",
    register: async () => {
      registerCount += 1;
      await Promise.resolve();
    },
  }, {});

  await Promise.all([app.ready(), app.ready()]);
  assertEquals(registerCount, 1);

  await assertRejects(
    () => app.register({ name: "late-plugin", register: () => undefined }, {}),
    ConfigurationError,
  );
});

Deno.test("circular plugin dependencies throw ConfigurationError", async () => {
  const app = createApp({ config });
  const p1: Plugin = { name: "p1", dependencies: ["p2"], register: () => undefined };
  const p2: Plugin = { name: "p2", dependencies: ["p1"], register: () => undefined };

  await app.register(p1, {});
  await app.register(p2, {});
  await assertRejects(() => app.ready(), ConfigurationError);
});

Deno.test("missing plugin dependencies throw ConfigurationError", async () => {
  const app = createApp({ config });
  const p1: Plugin = { name: "p1", dependencies: ["missingDep"], register: () => undefined };

  await app.register(p1, {});
  await assertRejects(() => app.ready(), ConfigurationError);
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

Deno.test("app - rejects duplicate routes and duplicate decorations", () => {
  const app = createApp({ config });
  const dummyRoute = defineRoute({
    method: "get",
    path: "/items",
    handler: () => "items",
  });

  app.route(dummyRoute);
  assertThrows(() => app.route(dummyRoute), ConfigurationError);

  app.decorate("myService", { value: 123 });
  assertEquals(app.getDecoration<{ value: number }>("myService")?.value, 123);
  assertThrows(() => app.decorate("myService", { value: 456 }), ConfigurationError);
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
