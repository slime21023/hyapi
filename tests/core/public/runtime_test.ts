import { assert, assertEquals, assertRejects } from "@std/assert";
import Type from "typebox";
import {
  type App,
  createApp,
  HttpError,
  implement,
  notImplemented,
  problem,
  StartupError,
} from "@hyapi/core";
import {
  defineApi,
  defineContract,
  defineResponse,
  defineSchema,
  Problem,
} from "@hyapi/core/contract";

const T = Type;

const Item = defineSchema(
  "Item",
  T.Object({ id: T.String(), name: T.String(), count: T.Integer({ format: "int32" }) }),
);
const CreateItem = defineSchema("CreateItem", T.Omit(Item, ["id"]));
const NotFound = defineResponse("NotFound", { description: "Not found", body: Problem });
const Search = defineSchema(
  "Search",
  T.Object({
    limit: T.Integer(),
    tags: T.Array(T.String()),
    ids: T.Array(T.Integer()),
    filter: T.Object({ name: T.String() }),
  }),
);

const items = defineContract({
  operations: {
    getItem: {
      method: "GET",
      path: "/items/{id}",
      params: T.Object({ id: T.String({ minLength: 2 }) }),
      responses: { 200: Item, 404: NotFound },
    },
    getMine: { method: "GET", path: "/items/mine", responses: { 200: Item } },
    deleteItem: {
      method: "DELETE",
      path: "/items/{id}",
      params: T.Object({ id: T.String() }),
      responses: { 204: { description: "Deleted" } },
    },
    createItem: {
      method: "POST",
      path: "/items",
      body: CreateItem,
      responses: {
        201: { description: "Created", body: Item, headers: T.Object({ location: T.String() }) },
      },
    },
    search: {
      method: "GET",
      path: "/search",
      query: T.Object({
        limit: T.Optional(T.With(T.Integer({ maximum: 50 }), { default: 20 })),
        tags: T.Optional(T.Array(T.String())),
        ids: T.Optional(T.Array(T.Integer())),
        filter: T.Optional(T.Object({ name: T.String() })),
      }),
      styles: { query: { ids: { explode: false }, filter: { style: "deepObject" } } },
      headers: T.Object({ "x-trace": T.Optional(T.String()) }),
      cookies: T.Object({ session: T.Optional(T.String()) }),
      responses: {
        200: T.Object({
          query: Search,
          trace: T.Optional(T.String()),
          session: T.Optional(T.String()),
        }),
      },
    },
    echoText: {
      method: "POST",
      path: "/echo",
      body: { schema: T.String({ maxLength: 10 }), mediaType: "text/plain", required: false },
      responses: { 200: { description: "Echo", body: T.String(), mediaType: "text/plain" } },
    },
    misbehave: {
      method: "GET",
      path: "/misbehave/{mode}",
      params: T.Object({ mode: T.String() }),
      responses: { 200: Item },
    },
    slow: { method: "GET", path: "/slow", responses: { 200: Item } },
    later: { method: "GET", path: "/later", responses: { 200: Item } },
  },
});

const api = defineApi({ info: { title: "Runtime", version: "1.0.0" }, contracts: [items] });

const stored = { id: "a1", name: "first", count: 1 };

function handlers() {
  return implement(items, {
    getItem: ({ params }) =>
      params.id === stored.id
        ? { status: 200, body: stored }
        : { status: 404, body: problem({ title: "Item not found", detail: params.id }) },
    getMine: () => ({ status: 200, body: { ...stored, id: "mine" } }),
    deleteItem: () => ({ status: 204 }),
    createItem: ({ body }) => ({
      status: 201,
      body: { id: "new", ...body },
      headers: { location: "/items/new" },
    }),
    search: ({ query, headers, cookies }) => ({
      status: 200,
      body: {
        query: {
          limit: query.limit,
          tags: query.tags ?? [],
          ids: query.ids ?? [],
          filter: query.filter ?? { name: "" },
        },
        ...(headers["x-trace"] ? { trace: headers["x-trace"] } : {}),
        ...(cookies.session ? { session: cookies.session } : {}),
      },
    }),
    echoText: ({ body }) => ({ status: 200, body: body ?? "(empty)" }),
    misbehave: ({ params }) => {
      switch (params.mode) {
        case "extra":
          return { status: 200, body: { ...stored, secret: "hidden" } as typeof stored };
        case "invalid":
          return { status: 200, body: { id: 1, name: "x" } as unknown as typeof stored };
        case "status":
          return { status: 418, body: stored } as never;
        case "http-error":
          throw new HttpError(409, { detail: "Conflict detail", code: "ITEM_CONFLICT" });
        case "throw":
          throw new Error("boom");
        case "raw":
          return new Response("raw", { status: 200 });
        default:
          return new Response("raw", { status: 202 });
      }
    },
    slow: (_input, ctx) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ status: 200, body: stored }), 5_000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(ctx.signal.reason);
        });
      }),
    later: notImplemented,
  });
}

async function appWith(options: Record<string, unknown> = {}): Promise<App> {
  return await createApp({ api, implementations: [handlers()], ...options });
}

async function call(app: App, method: string, path: string, init: RequestInit = {}) {
  const response = await app.fetch(new Request(`http://test${path}`, { method, ...init }));
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const body = type.includes("json") && text !== "" ? JSON.parse(text) : text;
  return { status: response.status, headers: response.headers, body };
}

// --- Routing -------------------------------------------------------------------------------------

Deno.test("routes to the declared operation and decodes path parameters", async () => {
  const app = await appWith();
  const found = await call(app, "GET", "/items/a1");
  assertEquals(found.status, 200);
  assertEquals(found.body, stored);
  assertEquals(found.headers.get("content-type"), "application/json");
});

Deno.test("literal paths win over templated paths", async () => {
  const app = await appWith();
  assertEquals((await call(app, "GET", "/items/mine")).body.id, "mine");
});

Deno.test("404 for undeclared paths, including trailing slashes", async () => {
  const app = await appWith();
  for (const path of ["/nothing", "/items/a1/", "/items"]) {
    const response = await call(app, "GET", path);
    assertEquals(response.status, path === "/items" ? 405 : 404, path);
    assertEquals(response.headers.get("content-type"), "application/problem+json");
  }
  const response = await call(app, "GET", "/nothing");
  assertEquals(response.body.type, "about:blank");
  assertEquals(response.body.code, "NOT_FOUND");
  assertEquals(response.body.status, 404);
});

Deno.test("405 with Allow lists methods across matching templates", async () => {
  const app = await appWith();
  const response = await call(app, "PUT", "/items/mine");
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "DELETE, GET, HEAD");
  assertEquals(response.body.code, "METHOD_NOT_ALLOWED");
  // DELETE falls through from the literal /items/mine to the templated /items/{id}.
  assertEquals((await call(app, "DELETE", "/items/mine")).status, 204);
});

Deno.test("HEAD is served by GET without a body", async () => {
  const app = await appWith();
  const response = await app.fetch(new Request("http://test/items/a1", { method: "HEAD" }));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals(await response.text(), "");
});

Deno.test("400 for malformed percent-encoding in the path", async () => {
  const app = await appWith();
  const response = await call(app, "GET", "/items/%E0%A4%A");
  assertEquals(response.status, 400);
  assertEquals(response.body.code, "MALFORMED_REQUEST");
});

// --- Parameters ----------------------------------------------------------------------------------

Deno.test("400 lists parameter violations with location and pointer", async () => {
  const app = await appWith();
  const response = await call(app, "GET", "/items/a");
  assertEquals(response.status, 400);
  assertEquals(response.body.code, "VALIDATION_FAILED");
  assertEquals(response.body.violations[0].location, "path");
  assertEquals(response.body.violations[0].pointer, "/id");
});

Deno.test("query styles, coercion, defaults, headers, and cookies", async () => {
  const app = await appWith();
  const response = await call(
    app,
    "GET",
    "/search?tags=a&tags=b&ids=1,2,3&filter[name]=x",
    { headers: { "X-Trace": "t-1", cookie: "other=1; session=s%201" } },
  );
  assertEquals(response.status, 200, JSON.stringify(response.body));
  assertEquals(response.body, {
    query: { limit: 20, tags: ["a", "b"], ids: [1, 2, 3], filter: { name: "x" } },
    trace: "t-1",
    session: "s 1",
  });
  const invalid = await call(app, "GET", "/search?limit=99&ids=1,x");
  assertEquals(invalid.status, 400);
  assertEquals(invalid.body.violations.map((v: { pointer: string }) => v.pointer).sort(), [
    "/ids/1",
    "/limit",
  ]);
});

// --- Bodies --------------------------------------------------------------------------------------

Deno.test("JSON bodies are validated and passed to the handler", async () => {
  const app = await appWith();
  const created = await call(app, "POST", "/items", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "n", count: 2 }),
  });
  assertEquals(created.status, 201);
  assertEquals(created.body, { id: "new", name: "n", count: 2 });
  assertEquals(created.headers.get("location"), "/items/new");

  const invalid = await call(app, "POST", "/items", {
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ name: "n", count: 2 ** 31 }),
  });
  assertEquals(invalid.status, 400);
  assertEquals(invalid.body.violations[0].pointer, "/count");
});

Deno.test("400 for malformed JSON and for a missing required body", async () => {
  const app = await appWith();
  const malformed = await call(app, "POST", "/items", {
    headers: { "content-type": "application/json" },
    body: "{nope",
  });
  assertEquals(malformed.status, 400);
  assertEquals(malformed.body.code, "MALFORMED_REQUEST");
  const missing = await call(app, "POST", "/items");
  assertEquals(missing.status, 400);
  assertEquals(missing.body.violations[0].location, "body");
});

Deno.test("413 by Content-Length and by streamed size", async () => {
  const app = await appWith({ bodyLimitBytes: 16 });
  const declared = await call(app, "POST", "/items", {
    headers: { "content-type": "application/json", "content-length": "1000" },
    body: JSON.stringify({ name: "n", count: 1 }),
  });
  assertEquals(declared.status, 413);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"name":"aaaaaaaaaaaaaaaaaaaa","count":1}'));
      controller.close();
    },
  });
  const streamed = await call(app, "POST", "/items", {
    headers: { "content-type": "application/json" },
    body: stream,
  });
  assertEquals(streamed.status, 413);
  assertEquals(streamed.body.code, "PAYLOAD_TOO_LARGE");
});

Deno.test("415 for an undeclared media type", async () => {
  const app = await appWith();
  const response = await call(app, "POST", "/items", {
    headers: { "content-type": "text/plain" },
    body: "hello",
  });
  assertEquals(response.status, 415);
  assertEquals(response.body.code, "UNSUPPORTED_MEDIA_TYPE");
  assertEquals(response.headers.get("accept-post"), "application/json");
});

Deno.test("text bodies and optional bodies", async () => {
  const app = await appWith();
  const echoed = await call(app, "POST", "/echo", {
    headers: { "content-type": "text/plain" },
    body: "hi",
  });
  assertEquals([echoed.status, echoed.body, echoed.headers.get("content-type")], [
    200,
    "hi",
    "text/plain",
  ]);
  assertEquals((await call(app, "POST", "/echo")).body, "(empty)");
  const tooLong = await call(app, "POST", "/echo", {
    headers: { "content-type": "text/plain" },
    body: "x".repeat(20),
  });
  assertEquals(tooLong.status, 400);
});

// --- Handlers and responses ----------------------------------------------------------------------

Deno.test("problem bodies get their status filled in", async () => {
  const app = await appWith();
  const response = await call(app, "GET", "/items/zz");
  assertEquals(response.status, 404);
  assertEquals(response.headers.get("content-type"), "application/problem+json");
  assertEquals(response.body, { title: "Item not found", detail: "zz", status: 404 });
});

Deno.test("204 responses have no body", async () => {
  const app = await appWith();
  const response = await call(app, "DELETE", "/items/a1");
  assertEquals([response.status, response.body], [204, ""]);
});

Deno.test("501 for notImplemented operations", async () => {
  const app = await appWith();
  const response = await call(app, "GET", "/later");
  assertEquals(response.status, 501);
  assertEquals(response.body.code, "NOT_IMPLEMENTED");
});

Deno.test("undeclared response fields are always stripped", async () => {
  for (const responseValidation of ["off", "log", "enforce"]) {
    const app = await appWith({ responseValidation });
    const response = await call(app, "GET", "/misbehave/extra");
    assertEquals(response.status, 200);
    assertEquals(response.body, stored, responseValidation);
  }
});

Deno.test("response validation policies", async () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    const enforce = await appWith({ responseValidation: "enforce" });
    const enforced = await call(enforce, "GET", "/misbehave/invalid");
    assertEquals([enforced.status, enforced.body.code], [500, "RESPONSE_CONTRACT_VIOLATION"]);
    assertEquals(enforced.body.violations, undefined, "violations are hidden outside development");

    const log = await appWith({ responseValidation: "log" });
    const logged = await call(log, "GET", "/misbehave/invalid");
    assertEquals(logged.status, 200);
    assert(warnings.some((w) => w.includes("response-contract-violation")));

    const off = await appWith({ responseValidation: "off" });
    assertEquals((await call(off, "GET", "/misbehave/invalid")).status, 200);

    const development = await appWith({ development: true });
    const detailed = await call(development, "GET", "/misbehave/invalid");
    assertEquals(detailed.status, 500, "development enforces by default");
    assert(detailed.body.violations.length > 0);
  } finally {
    console.warn = warn;
  }
});

Deno.test("undeclared statuses are contract violations", async () => {
  const app = await appWith({ responseValidation: "enforce" });
  assertEquals((await call(app, "GET", "/misbehave/status")).status, 500);
  assertEquals((await call(app, "GET", "/misbehave/raw-undeclared")).status, 500);
  const raw = await call(app, "GET", "/misbehave/raw");
  assertEquals([raw.status, raw.body], [200, "raw"]);
});

Deno.test("HttpError becomes a problem response", async () => {
  const app = await appWith();
  const response = await call(app, "GET", "/misbehave/http-error");
  assertEquals(response.status, 409);
  assertEquals(response.body.code, "ITEM_CONFLICT");
  assertEquals(response.body.detail, "Conflict detail");
  assertEquals(response.body.title, "Conflict");
});

Deno.test("thrown errors become 500 and reveal details only in development", async () => {
  const hidden = await call(await appWith(), "GET", "/misbehave/throw");
  assertEquals([hidden.status, hidden.body.code, hidden.body.debug], [
    500,
    "INTERNAL_ERROR",
    undefined,
  ]);
  const shown = await call(
    await appWith({ development: true, responseValidation: "log" }),
    "GET",
    "/misbehave/throw",
  );
  assertEquals(shown.body.debug.message, "boom");
});

Deno.test("503 when the handler exceeds the request timeout, and the signal aborts", async () => {
  const app = await appWith({ requestTimeoutMs: 20 });
  const response = await call(app, "GET", "/slow");
  assertEquals(response.status, 503);
  assertEquals(response.body.code, "REQUEST_TIMEOUT");
});

// --- Startup -------------------------------------------------------------------------------------

Deno.test("startup reports every implementation problem together", async () => {
  const other = defineContract({
    operations: {
      ping: { method: "GET", path: "/ping", responses: { 204: { description: "Pong" } } },
    },
  });
  const twoContracts = defineApi({ info: { title: "T", version: "1" }, contracts: [items, other] });
  const error = await assertRejects(
    () =>
      createApp({
        api: twoContracts,
        implementations: [
          handlers(),
          handlers(),
          {
            kind: "hyapi.implementation",
            contract: defineContract({ operations: {} }),
            handlers: {},
          },
        ],
      }),
    StartupError,
  );
  assertEquals(
    error.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).sort(),
    ["duplicate-implementation", "missing-implementation", "unknown-implementation"],
  );
});

Deno.test("startup rejects missing and unknown handlers, and invalid options", async () => {
  const broken = {
    kind: "hyapi.implementation",
    contract: items,
    handlers: { ...handlers().handlers, getItem: undefined, extra: () => {} },
  } as never;
  const error = await assertRejects(
    () => createApp({ api, implementations: [broken], requestTimeoutMs: 0 }),
    StartupError,
  );
  assertEquals(error.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).sort(), [
    "invalid-option",
    "missing-handler",
    "unknown-handler",
  ]);
});

Deno.test("startup rejects contract errors with their diagnostics", async () => {
  const bad = defineContract({
    operations: {
      a: {
        method: "GET",
        path: "/a",
        responses: { 200: defineSchema("F", T.Object({ v: T.String({ format: "made-up" }) })) },
      },
    },
  });
  const error = await assertRejects(
    () =>
      createApp({
        api: defineApi({ info: { title: "T", version: "1" }, contracts: [bad] }),
        implementations: [implement(bad, { a: notImplemented })],
      }),
    StartupError,
  );
  assertEquals(error.diagnostics.filter((d) => d.severity === "error").map((d) => d.code), [
    "unknown-format",
  ]);
});
