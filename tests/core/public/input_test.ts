import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, type Schema } from "hyapi";

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

function detailFixture() {
  const root = new Container();
  const asyncSchema: Schema = {
    "~standard": {
      version: 1,
      vendor: "async",
      validate: async () => ({ issues: [{ message: "never valid" }] }),
    },
  };
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "orders",
        prefix: "/orders",
        routes: (route) => [
          route.post("/:id", {
            params: v.object({ id: v.pipe(v.string(), v.uuid()) }),
            query: v.object({ term: v.string() }),
            body: v.object({
              user: v.object({ qty: v.pipe(v.number(), v.minValue(1)) }),
              tags: v.array(v.string()),
              "a/b~c": v.optional(v.string()),
            }),
            handler: () => "ok",
          }),
          route.get("/broken", {
            response: v.object({ n: v.number() }),
            handler: () => ({ n: "x" }) as never,
          }),
          route.post("/async", { body: asyncSchema, handler: () => "ok" }),
        ],
      }),
      module({
        name: "root",
        prefix: "/",
        routes: (route) => [
          route.get("/", { query: v.object({ q: v.string() }), handler: () => "ok" }),
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

const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const validBody = JSON.stringify({ user: { qty: 1 }, tags: [] });

test("validation failures list each issue with its location and JSON Pointer", async () => {
  const { send, close } = detailFixture();
  try {
    const body = await send(`/orders/${uuid}?term=x`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ user: { qty: 0 }, tags: ["a", 1], "a/b~c": 2 }),
    });
    assert.equal(body.status, 400);
    assert.equal(body.body.code, "VALIDATION_ERROR");
    assert.deepEqual(
      body.body.errors.map(({ in: location, pointer }: Record<string, string>) => [
        location,
        pointer,
      ]),
      [
        ["body", "/user/qty"],
        ["body", "/tags/1"],
        ["body", "/a~1b~0c"],
      ],
    );
    for (const issue of body.body.errors) assert.equal(typeof issue.message, "string");
  } finally {
    await close();
  }
});

test("query and params failures name their own location", async () => {
  const { send, close } = detailFixture();
  try {
    const query = await send(`/orders/${uuid}`, { method: "POST", headers: json, body: validBody });
    assert.deepEqual(
      query.body.errors.map((issue: Record<string, string>) => [issue.in, issue.pointer]),
      [["query", "/term"]],
    );
    const params = await send("/orders/nope?term=x", {
      method: "POST",
      headers: json,
      body: validBody,
    });
    assert.deepEqual(
      params.body.errors.map((issue: Record<string, string>) => [issue.in, issue.pointer]),
      [["params", "/id"]],
    );
    const rooted = await send("/");
    assert.deepEqual(
      rooted.body.errors.map((issue: Record<string, string>) => [issue.in, issue.pointer]),
      [["query", "/q"]],
    );
  } finally {
    await close();
  }
});

test("parse, response, and asynchronous validation failures carry no issue list", async () => {
  const { send, close } = detailFixture();
  try {
    const parse = await send(`/orders/${uuid}?term=x`, {
      method: "POST",
      headers: json,
      body: "{",
    });
    assert.deepEqual([parse.body.code, parse.body.errors], ["PARSE_ERROR", undefined]);
    const response = await send("/orders/broken");
    assert.deepEqual([response.status, response.body.errors], [500, undefined]);
    const asynchronous = await send("/orders/async", { method: "POST", headers: json, body: "{}" });
    assert.deepEqual(
      [asynchronous.status, asynchronous.body.code, asynchronous.body.errors],
      [400, "VALIDATION_ERROR", undefined],
    );
  } finally {
    await close();
  }
});
