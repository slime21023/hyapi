import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, reply, type ApplicationOptions, type OpenApiOptions, type Schema } from "hyapi";

type Modules = ApplicationOptions<Container>["modules"];

function foreign(vendor: string): Schema {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (value: unknown) => ({ value }),
    },
  };
}

function foreignBody(vendor: string): Modules {
  return ({ module }) => [
    module({
      name: "external",
      prefix: "/external",
      routes: (route) => [route.post("/", { body: foreign(vendor), handler: () => "ok" })],
    }),
  ];
}

const info = { title: "OpenAPI contract", version: "0.5.0" };

async function documentOf(modules: Modules, openapi: OpenApiOptions) {
  const root = new Container();
  const app = createApp({ container: root, modules, openapi });
  try {
    const response = await app.fetch(new Request(`http://localhost${openapi.path}/json`));
    assert.equal(response.status, 200);
    return await response.json();
  } finally {
    await app.close();
    await root.dispose();
  }
}

test("custom vendor converters project their schemas into the document", async () => {
  const converted: string[] = [];
  const document = await documentOf(foreignBody("acme"), {
    path: "/openapi",
    info,
    converters: {
      acme(schema) {
        converted.push(schema["~standard"].vendor);
        return { type: "object", title: "Acme" };
      },
    },
  });
  assert.ok(converted.length > 0);
  assert.equal(
    document.paths["/external/"].post.requestBody.content["application/json"].schema.title,
    "Acme",
  );
});

test("converters that do not return a JSON Schema object reject startup", () => {
  for (const result of [[], null, "schema"]) {
    assert.throws(
      () =>
        createApp({
          container: new Container(),
          modules: foreignBody("acme"),
          openapi: { path: "/openapi", info, converters: { acme: () => result as never } },
        }),
      /did not return a JSON Schema object/,
      JSON.stringify(result),
    );
  }
});

test("vendor lookup ignores inherited object keys", () => {
  for (const vendor of ["constructor", "__proto__", "toString"]) {
    assert.throws(
      () =>
        createApp({
          container: new Container(),
          modules: foreignBody(vendor),
          openapi: { path: "/openapi", info },
        }),
      /No OpenAPI JSON Schema converter/,
      vendor,
    );
  }
});

test("a valibot converter override is ignored in favour of the built-in projection", async () => {
  let called = false;
  const document = await documentOf(
    ({ module }) => [
      module({
        name: "items",
        prefix: "/items",
        routes: (route) => [
          route.post("/", {
            body: v.object({ count: v.pipe(v.number(), v.minValue(1)) }),
            handler: () => "ok",
          }),
        ],
      }),
    ],
    {
      path: "/openapi",
      info,
      converters: {
        valibot() {
          called = true;
          return { title: "override" };
        },
      },
    },
  );
  assert.equal(called, false);
  const schema = document.paths["/items/"].post.requestBody.content["application/json"].schema;
  assert.equal(schema.properties.count.minimum, 1);
});

test("protected modules must name a declared security scheme", () => {
  const protectedModules =
    (security?: string): Modules =>
    ({ module }) => [
      module({
        name: "private",
        prefix: "/private",
        authenticate: () => ({ subject: "a" }),
        ...(security ? { security } : {}),
        routes: (route) => [route.get("/", { handler: () => "ok" })],
      }),
    ];
  const securitySchemes = { BearerAuth: { type: "http", scheme: "bearer" } };
  for (const security of [undefined, "ApiKey", "constructor"]) {
    assert.throws(
      () =>
        createApp({
          container: new Container(),
          modules: protectedModules(security),
          openapi: { path: "/openapi", info, securitySchemes },
        }),
      /needs a declared OpenAPI security scheme/,
      String(security),
    );
  }
});

test("a custom documentation path serves JSON only and lists every declared status", async () => {
  const root = new Container();
  const item = v.object({ id: v.string() });
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "items",
        prefix: "/items",
        routes: (route) => [
          route.post("/", {
            response: { 200: item, 201: item, 202: v.object({ queued: v.boolean() }) },
            handler: () => reply(202, { queued: true }),
          }),
        ],
      }),
    ],
    openapi: { path: "/docs", info },
  });
  try {
    const json = await app.fetch(new Request("http://localhost/docs/json"));
    assert.equal(json.status, 200);
    const responses = (await json.json()).paths["/items/"].post.responses;
    assert.deepEqual(Object.keys(responses).toSorted(), ["200", "201", "202"]);
    assert.equal((await app.fetch(new Request("http://localhost/docs"))).status, 404);
    assert.equal((await app.fetch(new Request("http://localhost/openapi/json"))).status, 404);
  } finally {
    await app.close();
    await root.dispose();
  }
});

test("operation metadata, query parameters, and single response schemas are projected", async () => {
  const document = await documentOf(
    ({ module }) => [
      module({
        name: "catalog",
        prefix: "/catalog",
        routes: (route) => [
          route.get("/", {
            query: v.object({ term: v.string(), limit: v.optional(v.string()) }),
            response: v.object({ total: v.number() }),
            summary: "Search the catalog",
            description: "Matches items by term.",
            tags: ["Catalog", "Search"],
            handler: () => ({ total: 0 }),
          }),
          route.put("/:id", { body: v.object({ name: v.string() }), handler: () => "ok" }),
          route.patch("/:id", { body: v.object({ name: v.string() }), handler: () => "ok" }),
        ],
      }),
    ],
    { path: "/openapi", info },
  );
  const search = document.paths["/catalog/"].get;
  assert.equal(search.summary, "Search the catalog");
  assert.equal(search.description, "Matches items by term.");
  assert.deepEqual(search.tags, ["Catalog", "Search"]);
  assert.deepEqual(
    search.parameters.map(({ name, in: location, required }: Record<string, unknown>) => ({
      name,
      location,
      required,
    })),
    [
      { name: "term", location: "query", required: true },
      { name: "limit", location: "query", required: false },
    ],
  );
  assert.equal(
    search.responses["200"].content["application/json"].schema.properties.total.type,
    "number",
  );
  assert.deepEqual(Object.keys(document.paths["/catalog/{id}"]).toSorted(), ["patch", "put"]);
});

test("a schema transform that JSON Schema cannot represent rejects documented startup", () => {
  const modules: Modules = ({ module }) => [
    module({
      name: "paging",
      prefix: "/paging",
      routes: (route) => [
        route.get("/", {
          query: v.object({ page: v.pipe(v.string(), v.transform(Number)) }),
          handler: () => "ok",
        }),
      ],
    }),
  ];
  assert.throws(
    () => createApp({ container: new Container(), modules, openapi: { path: "/openapi", info } }),
    /"transform" action cannot be converted to JSON Schema/,
  );
  assert.doesNotThrow(() => createApp({ container: new Container(), modules }).close());
});

test("root-prefixed routes are documented without a doubled slash", async () => {
  const document = await documentOf(
    ({ module }) => [
      module({
        name: "root",
        prefix: "/",
        routes: (route) => [
          route.get("/", { handler: () => "index" }),
          route.get("/health", { handler: () => "ok" }),
        ],
      }),
    ],
    { path: "/openapi", info },
  );
  const paths = Object.keys(document.paths).filter((path) => !path.startsWith("/openapi"));
  assert.deepEqual(paths.toSorted(), ["/", "/health"]);
});

test("explicit operation IDs replace generated ones in the document", async () => {
  const document = await documentOf(
    ({ module }) => [
      module({
        name: "orders",
        prefix: "/orders",
        routes: (route) => [
          route.get("/", { operationId: "listOrders", handler: () => [] }),
          route.get("/:id", { handler: () => "one" }),
        ],
      }),
    ],
    { path: "/openapi", info },
  );
  assert.equal(document.paths["/orders/"].get.operationId, "listOrders");
  assert.equal(typeof document.paths["/orders/{id}"].get.operationId, "string");
  assert.notEqual(document.paths["/orders/{id}"].get.operationId, "listOrders");
});

test("undocumented routes skip schema projection but still validate requests", async () => {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "uploads",
        prefix: "/uploads",
        routes: (route) => [
          route.post("/", {
            documented: false,
            body: v.object({ name: v.string(), file: v.instance(File) }),
            handler: ({ body }) => ({ name: body.name, size: body.file.size }),
          }),
          route.get("/", { handler: () => [] }),
        ],
      }),
    ],
    openapi: { path: "/openapi", info },
  });
  try {
    const document = await (await app.fetch(new Request("http://localhost/openapi/json"))).json();
    assert.deepEqual(Object.keys(document.paths["/uploads/"]), ["get"]);
    const form = new FormData();
    form.set("name", "notes");
    form.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    const uploaded = await app.fetch(
      new Request("http://localhost/uploads/", { method: "POST", body: form }),
    );
    assert.deepEqual(await uploaded.json(), { name: "notes", size: 5 });
    const missing = new FormData();
    missing.set("name", "notes");
    const rejected = await app.fetch(
      new Request("http://localhost/uploads/", { method: "POST", body: missing }),
    );
    assert.equal(rejected.status, 400);
  } finally {
    await app.close();
    await root.dispose();
  }
});

test("only protected modules with documented routes need a security scheme", () => {
  const protectedModule =
    (documented: boolean): Modules =>
    ({ module }) => [
      module({
        name: "internal",
        prefix: "/internal",
        authenticate: () => ({ subject: "ops" }),
        routes: (route) => [
          route.get("/hidden", { documented: false, handler: () => "hidden" }),
          route.get("/shown", { documented, handler: () => "shown" }),
        ],
      }),
    ];
  assert.doesNotThrow(() =>
    createApp({
      container: new Container(),
      modules: protectedModule(false),
      openapi: { path: "/openapi", info },
    }),
  );
  assert.throws(
    () =>
      createApp({
        container: new Container(),
        modules: protectedModule(true),
        openapi: { path: "/openapi", info },
      }),
    /needs a declared OpenAPI security scheme/,
  );
});
