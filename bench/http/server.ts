// The server half of the HTTP load benchmark (bench/http/load.ts runs it in its own process).
// Prints "listening <port>" when ready. Run with --v8-flags=--expose-gc so that /memory can
// collect garbage before it measures.
import Type from "typebox";
import { createApp, implement } from "@hyapi/core";
import { defineApi, defineContract, defineSchema } from "@hyapi/core/contract";
import { serve } from "@hyapi/core/deno";

const T = Type;
const Item = defineSchema(
  "Item",
  T.Object({ id: T.String(), name: T.String(), tags: T.Array(T.String()) }),
);
const CreateItem = defineSchema("CreateItem", T.Omit(Item, ["id"]));
const Memory = defineSchema(
  "Memory",
  T.Object({ rss: T.Number(), heapUsed: T.Number(), heapTotal: T.Number() }),
);

const items = defineContract({
  operations: {
    getItem: {
      method: "GET",
      path: "/items/{id}",
      params: T.Object({ id: T.String({ minLength: 1 }) }),
      responses: { 200: Item },
    },
    createItem: {
      method: "POST",
      path: "/items",
      body: CreateItem,
      responses: { 201: Item },
    },
    memory: { method: "GET", path: "/memory", responses: { 200: Memory } },
  },
});

const gc = (globalThis as { gc?: () => void }).gc;
const app = await createApp({
  api: defineApi({ info: { title: "Load", version: "1" }, contracts: [items] }),
  onEvent: () => {},
  implementations: [
    implement(items, {
      getItem: ({ params }) => ({
        status: 200,
        body: { id: params.id, name: "An item", tags: ["a", "b"] },
      }),
      createItem: ({ body }) => ({ status: 201, body: { id: "new", ...body } }),
      memory: () => {
        gc?.();
        const { rss, heapUsed, heapTotal } = Deno.memoryUsage();
        return { status: 200, body: { rss, heapUsed, heapTotal } };
      },
    }),
  ],
});

serve(app, {
  hostname: "127.0.0.1",
  port: 0,
  signals: [],
  onListen: ({ port }) => console.log(`listening ${port}`),
});
