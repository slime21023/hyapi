import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, ForbiddenError, UnauthorizedError } from "hyapi";

const origin = "http://localhost";

function fixture() {
  const calls: string[] = [];
  const root = new Container().registerValue("secret", "ok" as string);
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "public",
        prefix: "/pub",
        routes: (route) => [
          route.get("/who", { handler: ({ identity }) => ({ anonymous: identity === undefined }) }),
        ],
      }),
      module({
        name: "private",
        prefix: "/priv",
        async authenticate(request, container) {
          calls.push(`${request.method} ${new URL(request.url).pathname}`);
          const mode = request.headers.get("authorization");
          const delay = Number(request.headers.get("x-delay") ?? "0");
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (mode === "null") return null as never;
          if (mode === "undefined") return undefined as never;
          if (mode === "boom") throw new Error("authentication internals");
          if (mode === "forbidden") throw new ForbiddenError("Account suspended.");
          if (mode !== `Bearer ${container.get("secret")}`) throw new UnauthorizedError();
          return { subject: request.headers.get("x-subject") ?? "anonymous" };
        },
        routes: (route) => [
          route.get("/who", { handler: ({ identity }) => ({ subject: identity.subject }) }),
          ...(["put", "patch", "delete"] as const).map((method) =>
            route[method]("/items/:id", {
              body: v.object({ name: v.string() }),
              handler: ({ identity }) => ({ method, subject: identity.subject }),
            }),
          ),
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
  return { app, calls, send, close };
}

test("authenticate results other than an identity fail closed", async () => {
  const { send, close } = fixture();
  try {
    for (const authorization of ["null", "undefined", "Bearer wrong"]) {
      const response = await send("/priv/who", { headers: { authorization } });
      assert.equal(response.status, 401, authorization);
      assert.equal((await response.json()).code, "UNAUTHORIZED");
    }
    const forbidden = await send("/priv/who", { headers: { authorization: "forbidden" } });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).detail, "Account suspended.");
    const failed = await send("/priv/who", { headers: { authorization: "boom" } });
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes("authentication internals"), false);
  } finally {
    await close();
  }
});

test("path and method variants never reach a protected handler without authentication", async () => {
  const { calls, send, close } = fixture();
  try {
    assert.equal((await send("/priv/who/")).status, 401);
    assert.equal((await send("/priv/who", { method: "HEAD" })).status, 401);
    assert.deepEqual(calls, ["GET /priv/who/", "HEAD /priv/who"]);
    calls.length = 0;
    assert.equal((await send("//priv/who")).status, 404);
    assert.equal((await send("/priv/who", { method: "POST" })).status, 404);
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

// Elysia locates the routed path by scanning from a fixed URL offset, so a short Host shifts it
// away from the URL pathname that authentication matches. Such requests must fail closed.
test("a host too short for the router never reaches a protected handler", async () => {
  const { app, calls, close } = fixture();
  try {
    for (const url of [
      "http://l/xx/priv/who",
      "http://ab/x/priv/who",
      "https://ab/priv/who",
      "http://l/priv/who",
    ]) {
      const response = await app.fetch(new Request(url));
      assert.equal(response.status, 400, url);
      assert.equal((await response.json()).code, "UNROUTABLE_REQUEST", url);
    }
    assert.deepEqual(calls, []);
    for (const url of ["http://abcd/priv/who", "https://abc/priv/who", "http://[::1]/priv/who"]) {
      assert.equal((await app.fetch(new Request(url))).status, 401, url);
    }
  } finally {
    await close();
  }
});

test("PUT, PATCH, and DELETE authenticate before parsing a malformed body", async () => {
  const { calls, send, close } = fixture();
  const malformed = { headers: { "content-type": "application/json" }, body: "{" };
  try {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const denied = await send("/priv/items/1", { method, ...malformed });
      assert.equal(denied.status, 401, method);
      const parsed = await send("/priv/items/1", {
        method,
        ...malformed,
        headers: { ...malformed.headers, authorization: "Bearer ok" },
      });
      assert.equal((await parsed.json()).code, "PARSE_ERROR", method);
      const accepted = await send("/priv/items/1", {
        method,
        headers: { ...malformed.headers, authorization: "Bearer ok", "x-subject": "ada" },
        body: '{"name":"bolt"}',
      });
      assert.deepEqual(await accepted.json(), { method: method.toLowerCase(), subject: "ada" });
    }
    assert.equal(calls.length, 9);
  } finally {
    await close();
  }
});

test("public routes skip authentication and receive no identity", async () => {
  const { calls, send, close } = fixture();
  try {
    const response = await send("/pub/who", { headers: { authorization: "Bearer ok" } });
    assert.deepEqual(await response.json(), { anonymous: true });
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

test("interleaved asynchronous authentication keeps each identity with its own request", async () => {
  const { send, close } = fixture();
  try {
    const headers = (subject: string, delay: number) => ({
      authorization: "Bearer ok",
      "x-subject": subject,
      "x-delay": String(delay),
    });
    const responses = await Promise.all([
      send("/priv/who", { headers: headers("slow", 40) }),
      send("/priv/who", { headers: headers("fast", 0) }),
      send("/priv/who", { headers: headers("middle", 20) }),
    ]);
    assert.deepEqual(await Promise.all(responses.map((response) => response.json())), [
      { subject: "slow" },
      { subject: "fast" },
      { subject: "middle" },
    ]);
  } finally {
    await close();
  }
});

test("a root-prefixed module routes single-slash paths and guards every spelling", async () => {
  let authenticated = 0;
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "admin",
        prefix: "/",
        authenticate(request) {
          authenticated++;
          if (request.headers.get("authorization") !== "ok") throw new UnauthorizedError();
          return { subject: "root" };
        },
        routes: (route) => [
          route.get("/", { handler: () => "index" }),
          route.get("/admin", { handler: ({ identity }) => identity.subject }),
          route.get("/users/:id", { handler: ({ params }) => params.id }),
        ],
      }),
    ],
  });
  const send = (path: string, authorization?: string) =>
    app.fetch(new Request(`${origin}${path}`, authorization ? { headers: { authorization } } : {}));
  try {
    assert.equal(await (await send("/", "ok")).text(), "index");
    assert.equal(await (await send("/admin", "ok")).text(), "root");
    assert.equal(await (await send("/users/7", "ok")).text(), "7");
    for (const path of ["/admin", "/users/7"]) assert.equal((await send(path)).status, 401, path);
    authenticated = 0;
    for (const path of ["//admin", "//users/7"]) assert.equal((await send(path)).status, 404, path);
    assert.equal(authenticated, 0);
  } finally {
    await app.close();
    await root.dispose();
  }
});
