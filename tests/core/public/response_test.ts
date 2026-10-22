import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, reply } from "hyapi";

const origin = "http://localhost";
const item = v.object({ id: v.string() });

function fixture() {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "responses",
        prefix: "/r",
        routes: (route) => [
          route.get("/default", { response: { 200: item }, handler: () => ({ id: "a" }) }),
          route.get("/explicit-200", {
            response: { 200: item },
            handler: () => reply(200, { id: "b" }),
          }),
          route.get("/invalid", {
            response: item,
            handler: () => ({ id: 1 }) as never,
          }),
          route.get("/undeclared-map", {
            response: { 201: item },
            handler: () => reply(202, { id: "c" }) as never,
          }),
          route.get("/undeclared-single", {
            response: item,
            handler: () => reply(201, { id: "d" }) as never,
          }),
          route.get("/unconstrained", { handler: () => reply(202, { queued: true }) }),
          route.get("/native", {
            response: item,
            handler: () => new Response("not json", { status: 207 }),
          }),
        ],
      }),
    ],
  });
  const send = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${origin}${path}`, init));
  const close = async () => {
    await app.close();
    await root.dispose();
  };
  return { send, close };
}

test("plain values and explicit 200 replies use the declared 200 schema", async () => {
  const { send, close } = fixture();
  try {
    for (const [path, id] of [
      ["/r/default", "a"],
      ["/r/explicit-200", "b"],
    ] as const) {
      const response = await send(path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), { id }, path);
    }
  } finally {
    await close();
  }
});

test("a body that violates its response schema fails privately", async () => {
  const { send, close } = fixture();
  try {
    const response = await send("/r/invalid");
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, "INTERNAL_SERVER_ERROR");
  } finally {
    await close();
  }
});

test("a reply status missing from the declared responses fails privately", async () => {
  const { send, close } = fixture();
  try {
    for (const path of ["/r/undeclared-map", "/r/undeclared-single"]) {
      const response = await send(path);
      assert.equal(response.status, 500, path);
      assert.equal((await response.json()).code, "INTERNAL_SERVER_ERROR", path);
    }
  } finally {
    await close();
  }
});

test("routes without response schemas may reply with any success status", async () => {
  const { send, close } = fixture();
  try {
    const response = await send("/r/unconstrained");
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { queued: true });
  } finally {
    await close();
  }
});

test("a native Response is returned as-is without schema validation", async () => {
  const { send, close } = fixture();
  try {
    const response = await send("/r/native");
    assert.equal(response.status, 207);
    assert.equal(await response.text(), "not json");
  } finally {
    await close();
  }
});

test("an undeclared method on a declared path is not found", async () => {
  const { send, close } = fixture();
  try {
    assert.equal((await send("/r/default", { method: "POST" })).status, 404);
  } finally {
    await close();
  }
});
