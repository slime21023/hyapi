// Request-path baseline for the runtime (roadmap M2). Results: _adr/baselines/request-path.md.
import Type from "typebox";
import { createApp, implement } from "@hyapi/core";
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
  T.Object({
    id: T.String(),
    name: T.String({ minLength: 1 }),
    price: T.Number(),
    tags: T.Array(T.String()),
    owner: T.Object({ id: T.String(), email: T.Optional(T.String({ format: "email" })) }),
  }),
);
const CreateItem = defineSchema("CreateItem", T.Omit(Item, ["id"]));
const NotFound = defineResponse("NotFound", { description: "Not found", body: Problem });

const items = defineContract({
  operations: {
    getItem: {
      method: "GET",
      path: "/items/{id}",
      params: T.Object({ id: T.String() }),
      responses: { 200: Item, 404: NotFound },
    },
    search: {
      method: "GET",
      path: "/items",
      query: T.Object({
        q: T.String(),
        limit: T.Optional(T.With(T.Integer({ maximum: 100 }), { default: 20 })),
        tags: T.Optional(T.Array(T.String())),
      }),
      responses: { 200: defineSchema("ItemList", T.Object({ items: T.Array(Item) })) },
    },
    createItem: {
      method: "POST",
      path: "/items",
      body: CreateItem,
      responses: { 201: Item },
    },
  },
});

const item = {
  id: "i1",
  name: "Item",
  price: 9.5,
  tags: ["a", "b"],
  owner: { id: "o1", email: "o@example.com" },
};
const app = await createApp({
  api: defineApi({ info: { title: "Bench", version: "1.0.0" }, contracts: [items] }),
  implementations: [
    implement(items, {
      getItem: ({ params }) => ({ status: 200, body: { ...item, id: params.id } }),
      search: ({ query }) => ({
        status: 200,
        body: { items: Array(Math.min(query.limit, 10)).fill(item) },
      }),
      createItem: ({ body }) => ({ status: 201, body: { id: "new", ...body } }),
    }),
  ],
});
const createBody = JSON.stringify({ ...item, id: undefined });

// A reference handler without HyAPI: the cost floor of a Request/Response round trip in Deno.
const plain = (request: Request) => {
  const id = new URL(request.url).pathname.split("/")[2];
  return Response.json({ ...item, id });
};

Deno.bench(
  "reference: plain fetch handler, GET /items/{id}",
  { group: "get", baseline: true },
  async () => {
    await (await plain(new Request("http://bench/items/i1"))).text();
  },
);
Deno.bench("hyapi: GET /items/{id}", { group: "get" }, async () => {
  await (await app.fetch(new Request("http://bench/items/i1"))).text();
});
Deno.bench("hyapi: GET /items?q&limit&tags (query decoding)", async () => {
  await (await app.fetch(new Request("http://bench/items?q=x&limit=5&tags=a&tags=b"))).text();
});
Deno.bench("hyapi: POST /items (JSON body)", async () => {
  await (await app.fetch(
    new Request("http://bench/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: createBody,
    }),
  )).text();
});
Deno.bench("hyapi: 404 for an undeclared path", async () => {
  await (await app.fetch(new Request("http://bench/nothing/here"))).text();
});
