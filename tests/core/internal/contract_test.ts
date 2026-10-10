import { assert, assertEquals, assertFalse } from "@std/assert";
import Type from "typebox";
import {
  apiKey,
  defineApi,
  defineContract,
  defineResponse,
  defineSchema,
  defineSecurity,
  httpBearer,
  Problem,
} from "@hyapi/core/contract";
import { compileContracts } from "../../../packages/core/src/contract/compile/compile.ts";

const T = Type;
const Ok = defineSchema("Ok", T.Object({ ok: T.Boolean() }));
const info = { title: "Test", version: "1.0.0" };

Deno.test("a valid API normalizes into a ContractModel", () => {
  const security = defineSecurity({
    bearer: httpBearer<{ subject: string }>(),
    key: apiKey<{ client: string }>({ in: "header", name: "x-api-key" }),
  });
  const Item = defineSchema("Item", T.Object({ id: T.String(), name: T.String() }));
  const ItemList = defineSchema("ItemList", T.Object({ items: T.Array(Item) }));
  const NotFound = defineResponse("NotFound", { description: "Not found", body: Problem });

  const items = defineContract({
    securitySchemes: security,
    security: [{ bearer: ["items:read"] }],
    tags: ["items"],
    operations: {
      listItems: {
        method: "GET",
        path: "/items",
        query: T.Object({
          limit: T.Optional(T.With(T.Integer(), { default: 20 })),
          filter: T.Optional(T.Object({ name: T.String() })),
        }),
        styles: { query: { filter: { style: "deepObject" } } },
        responses: { 200: ItemList },
      },
      getItem: {
        method: "GET",
        path: "/items/{id}",
        security: [{ bearer: ["items:read"] }, { key: [] }],
        params: T.Object({ id: T.String() }),
        headers: T.Object({ "if-none-match": T.Optional(T.String()) }),
        responses: { 200: Item, 404: NotFound },
      },
      createItem: {
        method: "POST",
        path: "/items",
        tags: ["admin"],
        body: { schema: Item, required: false, description: "The item" },
        responses: {
          201: { description: "Created", body: Item, headers: T.Object({ location: T.String() }) },
        },
      },
    },
  });
  const health = defineContract({
    operations: {
      health: {
        method: "GET",
        path: "/health",
        security: [],
        responses: { 204: { description: "Healthy" } },
      },
      status: { method: "GET", path: "/status", responses: { 200: Ok } },
    },
  });

  const result = compileContracts(
    defineApi({
      info,
      securitySchemes: security,
      security: [{ key: [] }],
      contracts: [items, health],
    }),
  );
  assert(result.ok, JSON.stringify(result.diagnostics));
  const { model } = result;

  assertEquals(model.operations.map((o) => o.operationId), [
    "listItems",
    "getItem",
    "createItem",
    "health",
    "status",
  ]);
  assertEquals(
    model.operations.map((o) => [o.operationId, o.securityOrigin]),
    [
      ["listItems", "contract"],
      ["getItem", "operation"],
      ["createItem", "contract"],
      ["health", "operation"],
      ["status", "api"],
    ],
  );
  const [listItems, getItem, createItem, healthOp, status] = model.operations;
  assertEquals(healthOp!.security, []);
  assertEquals(status!.security, [[{ scheme: "key", scopes: [] }]]);
  assertEquals(getItem!.security, [
    [{ scheme: "bearer", scopes: ["items:read"] }],
    [{ scheme: "key", scopes: [] }],
  ]);

  // Parameters: locations, style defaults, overrides, requiredness, and defaults.
  assertEquals(
    listItems!.parameters.map((p) => [p.name, p.in, p.style, p.explode, p.required, p.hasDefault]),
    [
      ["limit", "query", "form", true, false, true],
      ["filter", "query", "deepObject", true, false, false],
    ],
  );
  assertEquals(
    getItem!.parameters.map((p) => [p.name, p.in, p.style, p.explode, p.required]),
    [
      ["id", "path", "simple", false, true],
      ["if-none-match", "header", "simple", false, false],
    ],
  );
  assertEquals(getItem!.pathParameters, ["id"]);

  // Responses: shorthand descriptions, problem media type, named responses, and headers.
  assertEquals(
    getItem!.responses.map((r) => [r.status, r.description, r.body?.mediaType, r.name]),
    [
      [200, "OK", "application/json", undefined],
      [404, "Not found", "application/problem+json", "NotFound"],
    ],
  );
  assertEquals(createItem!.responses[0]!.headers.map((h) => [h.name, h.required]), [[
    "location",
    true,
  ]]);
  assertEquals(healthOp!.responses[0]!.body, undefined);

  // Bodies and tags.
  assertEquals(createItem!.body?.mediaType, "application/json");
  assertEquals(createItem!.body?.required, false);
  assertEquals(createItem!.body?.description, "The item");
  assertEquals(createItem!.tags, ["admin"]);
  assertEquals(listItems!.tags, ["items"]);
  assertEquals(status!.tags, []);

  // Named components in first-reference order, including nested schemas.
  assertEquals(model.schemas.map((s) => s.name), ["ItemList", "Item", "Problem", "Ok"]);
  assertEquals(model.responses.map((r) => r.name), ["NotFound"]);
  assertEquals(model.securitySchemes.map((s) => s.name), ["bearer", "key"]);
  assertEquals(model.security, [[{ scheme: "key", scopes: [] }]]);
  assert(Object.isFrozen(model) && Object.isFrozen(model.operations));
});

Deno.test("defineSchema returns a named copy and leaves the input schema unnamed", () => {
  const plain = T.Object({ a: T.String() });
  const named = defineSchema("Named", plain);
  assert(named !== plain);
  assertEquals(JSON.stringify(named), JSON.stringify(plain));
  const result = compileContracts(
    defineApi({
      info,
      contracts: [
        defineContract({
          operations: { a: { method: "GET", path: "/a", responses: { 200: named } } },
        }),
      ],
    }),
  );
  assert(result.ok);
  assertEquals(result.model.schemas.map((s) => s.name), ["Named"]);
});

Deno.test("the model is a frozen copy that keeps TypeBox's markers", () => {
  const User = defineSchema("User", T.Object({ id: T.String() }));
  const api = defineApi({
    info,
    contracts: [
      defineContract({
        operations: {
          getUser: { method: "GET", path: "/user", responses: { 200: User } },
          listUsers: { method: "GET", path: "/users", responses: { 200: T.Array(User) } },
        },
      }),
    ],
  });
  const result = compileContracts(api);
  assert(result.ok);
  const { model } = result;
  const schema = model.schemas[0]!.schema as unknown as Record<string, unknown>;
  const [getUser, listUsers] = model.operations;

  // A copy, deeply frozen, with one object per shared schema.
  assert(schema !== (User as unknown));
  assert(Object.isFrozen(schema) && Object.isFrozen(schema.properties));
  assert(Object.isFrozen(model.info));
  assert(getUser!.responses[0]!.body!.schema === model.schemas[0]!.schema);
  const items = (listUsers!.responses[0]!.body!.schema as unknown as { items: unknown }).items;
  assert(items === model.schemas[0]!.schema);

  // Hidden markers survive, so TypeBox's Convert, Default, and Clean still work on the model.
  assertEquals(schema["~kind"], "Object");
  assertFalse(Object.keys(schema).includes("~kind"));

  // Later changes to the declaration cannot reach the model.
  (User.properties as Record<string, unknown>).extra = T.Number();
  assertEquals(Object.keys(schema.properties as object), ["id"]);
});

Deno.test("declared formats are part of the model", () => {
  const isIsbn = (value: string) => /^\d{13}$/.test(value);
  const result = compileContracts(
    defineApi({
      info,
      formats: { isbn: isIsbn },
      contracts: [
        defineContract({
          operations: {
            a: {
              method: "GET",
              path: "/a",
              query: T.Object({ isbn: T.String({ format: "isbn" }) }),
              responses: { 200: Ok },
            },
          },
        }),
      ],
    }),
  );
  assert(result.ok, JSON.stringify(result.diagnostics));
  assertEquals(result.model.formats.map((f) => f.name), ["isbn"]);
  assert(result.model.formats[0]!.check === isIsbn);
});
