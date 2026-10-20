import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, ForbiddenError, reply, UnauthorizedError } from "hyapi";

const origin = "http://localhost";
const input = v.object({ value: v.pipe(v.number(), v.minValue(1)) });
const output = v.object({ subject: v.string(), value: v.number() });

function fixture() {
  const events: string[] = [];
  const root = new Container()
    .declareScopeInputs<{ identity: { subject: string } }>()
    .registerValue("secret", "ok")
    .registerFactory(
      "requestService",
      (c) => {
        const subject = c.get("identity").subject;
        events.push(`open:${subject}`);
        return {
          subject,
          dispose() {
            events.push(`close:${subject}`);
          },
        };
      },
      ["identity"],
      "scoped",
    );
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "public",
        prefix: "/health",
        routes: (route) => [route.get("/", { handler: () => ({ status: "ok" }) })],
      }),
      module({
        name: "protected",
        prefix: "/private",
        security: "BearerAuth",
        authenticate(request, container) {
          if (request.headers.get("authorization") !== `Bearer ${container.get("secret")}`)
            throw new UnauthorizedError();
          return { subject: request.headers.get("x-subject") ?? "anonymous" };
        },
        routes: (route) => [
          route.post("/", {
            body: input,
            response: { 201: output },
            scoped: true,
            authorize({ body, identity, scope }) {
              assert.equal(scope.get("requestService").subject, identity.subject);
              if (body.value === 13) throw new ForbiddenError();
            },
            handler({ body, identity, scope }) {
              assert.equal(scope.get("identity").subject, identity.subject);
              return reply(201, { subject: identity.subject, value: body.value });
            },
          }),
          route.get("/who", { handler: ({ identity }) => ({ subject: identity.subject }) }),
        ],
      }),
    ],
    openapi: {
      path: "/openapi",
      info: { title: "Contract", version: "0.5.0" },
      securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } },
    },
  });
  const send = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${origin}${path}`, init));
  return { app, root, events, send };
}

test("HyAPI-only auth runs before parsing, validation precedes authorization, and scopes always close", async () => {
  const { app, root, events, send } = fixture();
  try {
    assert.equal((await send("/health/")).status, 200);
    const invalid = { method: "POST", headers: { "content-type": "application/json" }, body: "{" };
    const unauthenticated = await send("/private/", invalid);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("content-type"), "application/problem+json");
    assert.equal(events.length, 0);
    for (const path of ["/PRIVATE/", "/priv%61te/"]) {
      const alternate = await send(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"value":2}',
      });
      assert.ok(
        [401, 404].includes(alternate.status),
        `Unexpected unguarded ${path}: ${alternate.status}`,
      );
    }
    const head = await send("/private/who", { method: "HEAD" });
    assert.ok([401, 404, 405].includes(head.status), `Unexpected unguarded HEAD: ${head.status}`);
    const headers = { "content-type": "application/json", authorization: "Bearer ok" };
    assert.equal((await send("/private/", { ...invalid, headers })).status, 400);
    assert.equal(
      (await send("/private/", { method: "POST", headers, body: '{"value":0}' })).status,
      400,
    );
    assert.equal(events.length, 0);
    assert.equal(
      (await send("/private/", { method: "POST", headers, body: '{"value":13}' })).status,
      403,
    );
    assert.deepEqual(events, ["open:anonymous", "close:anonymous"]);
    const successes = await Promise.all(
      ["ada", "lin"].map((subject) =>
        send("/private/", {
          method: "POST",
          headers: { ...headers, "x-subject": subject },
          body: '{"value":2}',
        }),
      ),
    );
    assert.deepEqual(await Promise.all(successes.map((res) => res.json())), [
      { subject: "ada", value: 2 },
      { subject: "lin", value: 2 },
    ]);
    assert.deepEqual(
      events.slice(-4).sort(),
      ["open:ada", "open:lin", "close:ada", "close:lin"].sort(),
    );
    const document = await (await send("/openapi/json")).json();
    assert.deepEqual(document.paths["/private/"].post.security, [{ BearerAuth: [] }]);
    assert.equal(
      document.paths["/private/"].post.responses["201"].content["application/json"].schema
        .properties.subject.type,
      "string",
    );
    assert.equal(
      document.paths["/private/"].post.requestBody.content["application/json"].schema.properties
        .value.minimum,
      1,
    );
    assert.equal(document.paths["/health/"].get.security, undefined);
  } finally {
    await app.close();
    await root.dispose();
  }
});

test("closing waits for a scoped handler, rejects new work, and leaves the caller's root alive", async () => {
  const events: string[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const appRoot = new Container().registerValue("answer", 42).registerFactory(
    "resource",
    () => ({
      dispose: () => {
        events.push("disposed");
      },
    }),
    "scoped",
  );
  const app = createApp({
    container: appRoot,
    modules: ({ module }) => [
      module({
        name: "waiting",
        prefix: "/wait",
        routes: (route) => [
          route.get("/", {
            scoped: true,
            async handler({ scope, root }) {
              scope.get("resource");
              entered();
              await held;
              return { answer: root.get("answer") };
            },
          }),
        ],
      }),
    ],
  });
  try {
    const response = app.fetch(new Request(`${origin}/wait/`));
    await started;
    const closing = app.close();
    assert.equal((await app.fetch(new Request(`${origin}/wait/`))).status, 503);
    assert.deepEqual(events, []);
    release();
    assert.deepEqual(await (await response).json(), { answer: 42 });
    await closing;
    assert.deepEqual(events, ["disposed"]);
    assert.equal(appRoot.get("answer"), 42);
  } finally {
    release();
    await app.close();
    await appRoot.dispose();
  }
});

test("real HTTP listener binds and stops on Bun and Node without exposing Elysia", async () => {
  const { app, root } = fixture();
  try {
    const listener = await app.listen({ hostname: "127.0.0.1", port: 0 });
    try {
      assert.ok(listener.url.port && listener.url.port !== "0");
      const response = await fetch(new URL("/health/", listener.url));
      assert.deepEqual(await response.json(), { status: "ok" });
    } finally {
      await listener.stop();
      await listener.stop();
    }
  } finally {
    await app.close();
    await root.dispose();
  }
});

test("unexpected errors stay private and incomplete protected documentation is rejected", async () => {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "fail",
        prefix: "/fail",
        routes: (route) => [
          route.get("/", {
            handler() {
              throw new Error("secret database password");
            },
          }),
        ],
      }),
    ],
  });
  try {
    const response = await app.fetch(new Request(`${origin}/fail/`));
    assert.equal(response.status, 500);
    const detail = await response.text();
    assert.equal(detail.includes("secret database password"), false);
    assert.equal((await app.fetch(new Request(`${origin}/openapi/json`))).status, 404);
  } finally {
    await app.close();
    await root.dispose();
  }
  assert.throws(
    () =>
      createApp({
        container: new Container(),
        modules: ({ module }) => [
          module({
            name: "private",
            prefix: "/private",
            authenticate: () => ({ subject: "a" }),
            routes: (route) => [route.get("/", { handler: () => "ok" })],
          }),
        ],
        openapi: { path: "/openapi", info: { title: "Invalid", version: "0.5.0" } },
      }),
    /security scheme/,
  );
});

test("composition rejects overlapping authentication policies and undocumented schema vendors", () => {
  assert.throws(
    () =>
      createApp({
        container: new Container(),
        modules: ({ module }) => [
          module({
            name: "public",
            prefix: "/v1",
            routes: (route) => [route.get("/items/fixed", { handler: () => "public" })],
          }),
          module({
            name: "protected",
            prefix: "/v1/items",
            authenticate: () => ({ subject: "owner" }),
            routes: (route) => [route.get("/:id", { handler: () => "private" })],
          }),
        ],
      }),
    /Overlapping routes/,
  );
  const foreign = {
    "~standard": {
      version: 1 as const,
      vendor: "not-valibot",
      validate(value: unknown) {
        return { value };
      },
    },
  };
  assert.throws(
    () =>
      createApp({
        container: new Container(),
        modules: ({ module }) => [
          module({
            name: "external",
            prefix: "/external",
            routes: (route) => [
              route.post("/", {
                body: foreign,
                handler: ({ body }) => body,
              }),
            ],
          }),
        ],
        openapi: { path: "/docs", info: { title: "Missing converter", version: "0.5.0" } },
      }),
    /No OpenAPI JSON Schema converter/,
  );
});
