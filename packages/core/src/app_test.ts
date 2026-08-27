import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type AppConfig, createApp, defineRoute, type Plugin } from "../mod.ts";
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

Deno.test("routes validate input, return typed JSON, and preserve request ids", async () => {
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
      response: Type.Object({ id: Type.String(), limit: Type.Integer() }),
      handler: ({ params, query }) => {
        lifecycle.push("handler");
        return { id: params.id, limit: query.limit ?? 10 };
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

Deno.test("plugins enforce dependencies and duplicate registration", async () => {
  const app = createApp({ config });
  const base: Plugin = { name: "base", register: () => undefined };
  const dependent: Plugin = {
    name: "dependent",
    dependencies: ["base"],
    register: () => undefined,
  };

  await assertRejects(() => app.register(dependent, {}), ConfigurationError);
  await app.register(base, {});
  await app.register(dependent, {});
  await assertRejects(() => app.register(base, {}), ConfigurationError);
  assert(true);
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

Deno.test("response schema violation returns 500 response validation error", async () => {
  const app = createApp({ config });
  app.route(
    defineRoute({
      method: "get",
      path: "/broken",
      response: Type.Object({ count: Type.Integer() }),
      handler: () => ({ count: "not-a-number" }),
    }),
  );
  await app.ready();

  const response = await app.request("http://test/broken");
  assertEquals(response.status, 500);
  const problem = await response.json();
  assertEquals(problem.code, "RESPONSE_VALIDATION_ERROR");
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
      response: Type.Object({ tags: Type.Array(Type.String()) }),
      handler: ({ query }) => ({ tags: query.tag }),
    }),
  );
  await app.ready();

  const response = await app.request("http://test/tags?tag=deno");
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result, { tags: ["deno"] });
});
