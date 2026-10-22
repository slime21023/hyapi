import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp } from "hyapi";

const origin = "http://localhost";
const json = { "content-type": "application/json" };

function fixture() {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "input",
        prefix: "/in",
        routes: (route) => [
          route.get("/search", {
            query: v.object({ term: v.string(), limit: v.optional(v.string()) }),
            handler: ({ query }) => ({ query }),
          }),
          route.get("/page", {
            query: v.object({ page: v.pipe(v.string(), v.transform(Number), v.integer()) }),
            handler: ({ query }) => ({ page: query.page, type: typeof query.page }),
          }),
          route.get("/raw", { handler: ({ query }) => ({ query }) }),
          route.put("/items/:id", {
            params: v.object({ id: v.pipe(v.string(), v.uuid()) }),
            body: v.object({ name: v.string() }),
            handler: ({ params, body }) => ({ method: "PUT", id: params.id, name: body.name }),
          }),
          route.patch("/items/:id", {
            body: v.object({ name: v.optional(v.string()) }),
            handler: ({ params, body }) => ({ method: "PATCH", id: params.id, body }),
          }),
        ],
      }),
    ],
  });
  const send = async (path: string, init?: RequestInit) => {
    const response = await app.fetch(new Request(`${origin}${path}`, init));
    return { status: response.status, body: await response.json() };
  };
  const close = async () => {
    await app.close();
    await root.dispose();
  };
  return { send, close };
}

test("query schemas validate, strip undeclared keys, and allow optional keys", async () => {
  const { send, close } = fixture();
  try {
    assert.deepEqual(await send("/in/search?term=bolt&limit=5"), {
      status: 200,
      body: { query: { term: "bolt", limit: "5" } },
    });
    assert.deepEqual((await send("/in/search?term=bolt&debug=1")).body, {
      query: { term: "bolt" },
    });
    const missing = await send("/in/search?limit=5");
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "VALIDATION_ERROR");
  } finally {
    await close();
  }
});

test("a repeated query key does not satisfy a single string field", async () => {
  const { send, close } = fixture();
  try {
    const repeated = await send("/in/search?term=a&term=b");
    assert.equal(repeated.status, 400);
    assert.equal(repeated.body.code, "VALIDATION_ERROR");
  } finally {
    await close();
  }
});

test("query transforms reach the handler as their output type", async () => {
  const { send, close } = fixture();
  try {
    assert.deepEqual((await send("/in/page?page=3")).body, { page: 3, type: "number" });
    for (const page of ["x", "1.5"]) {
      const invalid = await send(`/in/page?page=${page}`);
      assert.equal(invalid.status, 400, page);
      assert.equal(invalid.body.code, "VALIDATION_ERROR", page);
    }
  } finally {
    await close();
  }
});

test("routes without a query schema receive every query value as a string", async () => {
  const { send, close } = fixture();
  try {
    assert.deepEqual((await send("/in/raw?a=1&b=two")).body, { query: { a: "1", b: "two" } });
    assert.deepEqual((await send("/in/raw")).body, { query: {} });
  } finally {
    await close();
  }
});

test("PUT and PATCH routes validate params and bodies", async () => {
  const { send, close } = fixture();
  const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  try {
    assert.deepEqual(
      await send(`/in/items/${id}`, { method: "PUT", headers: json, body: '{"name":"bolt"}' }),
      { status: 200, body: { method: "PUT", id, name: "bolt" } },
    );
    assert.deepEqual(await send("/in/items/any", { method: "PATCH", headers: json, body: "{}" }), {
      status: 200,
      body: { method: "PATCH", id: "any", body: {} },
    });
    const badParam = await send("/in/items/not-a-uuid", {
      method: "PUT",
      headers: json,
      body: '{"name":"bolt"}',
    });
    assert.deepEqual([badParam.status, badParam.body.code], [400, "VALIDATION_ERROR"]);
  } finally {
    await close();
  }
});

test("malformed and invalid bodies fail with distinct problem codes", async () => {
  const { send, close } = fixture();
  try {
    const malformed = await send("/in/items/any", { method: "PATCH", headers: json, body: "{" });
    assert.deepEqual(
      [malformed.status, malformed.body.code, malformed.body.detail],
      [400, "PARSE_ERROR", "Request body could not be parsed."],
    );
    const invalid = await send("/in/items/any", {
      method: "PATCH",
      headers: json,
      body: '{"name":1}',
    });
    assert.deepEqual(
      [invalid.status, invalid.body.code, invalid.body.detail],
      [400, "VALIDATION_ERROR", "Request validation failed."],
    );
  } finally {
    await close();
  }
});
