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
    assert.deepEqual(Object.keys(responses).sort(), ["200", "201", "202"]);
    assert.equal((await app.fetch(new Request("http://localhost/docs"))).status, 404);
    assert.equal((await app.fetch(new Request("http://localhost/openapi/json"))).status, 404);
  } finally {
    await app.close();
    await root.dispose();
  }
});
