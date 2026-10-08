// Generates RFC 0001-shaped APIs of a given operation count for the type-performance spike.
// Each resource has 10 operations, realistic schemas, named responses, and security.
// Usage: deno run -A generate.ts 50 200 500
const OPS_PER_RESOURCE = 10;

function schemasFile(r: number): string {
  return `import { defineSchema, T } from "../../../lib/hyapi.ts";

export const Item${r} = defineSchema(
  "Item${r}",
  T.Object({
    id: T.String({ format: "uuid" }),
    name: T.String({ minLength: 1, maxLength: 200 }),
    description: T.Optional(T.String()),
    status: T.Union([T.Literal("draft"), T.Literal("active"), T.Literal("archived")]),
    count: T.Integer({ minimum: 0 }),
    price: T.Number(),
    tags: T.Array(T.String()),
    owner: T.Object({
      id: T.String(),
      name: T.String(),
      email: T.Optional(T.String({ format: "email" })),
    }),
    metadata: T.Record(T.String(), T.String()),
    createdAt: T.String({ format: "date-time" }),
    updatedAt: T.Optional(T.String({ format: "date-time" })),
    flags: T.Optional(T.Array(T.Object({ key: T.String(), enabled: T.Boolean() }))),
  }),
);
export const CreateItem${r} = defineSchema(
  "CreateItem${r}",
  T.Omit(Item${r}, ["id", "createdAt", "updatedAt"]),
);
export const UpdateItem${r} = defineSchema("UpdateItem${r}", T.Partial(CreateItem${r}));
export const ItemList${r} = defineSchema(
  "ItemList${r}",
  T.Object({ items: T.Array(Item${r}), total: T.Integer(), next: T.Optional(T.String()) }),
);
export const Child${r} = defineSchema(
  "Child${r}",
  T.Object({ id: T.String(), parentId: T.String(), label: T.String(), position: T.Integer() }),
);
`;
}

function contractFile(r: number): string {
  const p = `/r${r}/items`;
  return `import { defineContract, T } from "../../../lib/hyapi.ts";
import { Conflict, NotFound, security, ValidationFailed } from "../shared.ts";
import { Child${r}, CreateItem${r}, Item${r}, ItemList${r}, UpdateItem${r} } from "./schemas.ts";

const Id = T.Object({ id: T.String({ format: "uuid" }) });

export const contract${r} = defineContract({
  securitySchemes: security,
  tags: ["r${r}"],
  operations: {
    // ops:start
    listItems${r}: {
      method: "GET",
      path: "${p}",
      security: [{ bearer: ["r${r}:read"] }, { key: [] }],
      query: T.Object({
        offset: T.Optional(T.Integer({ minimum: 0 })),
        limit: T.Optional(T.Integer({ minimum: 1, maximum: 100 })),
        status: T.Optional(T.Union([T.Literal("draft"), T.Literal("active"), T.Literal("archived")])),
      }),
      responses: { 200: ItemList${r} },
    },
    getItem${r}: {
      method: "GET",
      path: "${p}/{id}",
      security: [{ bearer: ["r${r}:read"] }],
      params: Id,
      responses: { 200: Item${r}, 404: NotFound },
    },
    createItem${r}: {
      method: "POST",
      path: "${p}",
      security: [{ bearer: ["r${r}:write"] }],
      body: CreateItem${r},
      responses: {
        201: { description: "Created", body: Item${r}, headers: T.Object({ location: T.String() }) },
        409: Conflict,
        422: ValidationFailed,
      },
    },
    updateItem${r}: {
      method: "PATCH",
      path: "${p}/{id}",
      security: [{ bearer: ["r${r}:write"] }],
      params: Id,
      body: UpdateItem${r},
      responses: { 200: Item${r}, 404: NotFound, 409: Conflict },
    },
    replaceItem${r}: {
      method: "PUT",
      path: "${p}/{id}",
      security: [{ bearer: ["r${r}:write"] }],
      params: Id,
      headers: T.Object({ "if-match": T.Optional(T.String()) }),
      body: CreateItem${r},
      responses: { 200: Item${r}, 404: NotFound, 412: { description: "Precondition failed" } },
    },
    deleteItem${r}: {
      method: "DELETE",
      path: "${p}/{id}",
      security: [{ bearer: ["r${r}:write"] }],
      params: Id,
      responses: { 204: { description: "Deleted" }, 404: NotFound },
    },
    getChild${r}: {
      method: "GET",
      path: "${p}/{id}/children/{childId}",
      security: [{ bearer: ["r${r}:read"] }],
      params: T.Object({ id: T.String(), childId: T.String() }),
      responses: { 200: Child${r}, 404: NotFound },
    },
    archiveItem${r}: {
      method: "POST",
      path: "${p}/{id}/archive",
      security: [{ bearer: ["r${r}:write"], key: [] }],
      params: Id,
      body: {
        schema: T.Object({ reason: T.Optional(T.String()) }),
        required: false,
        description: "Optional archive reason",
      },
      responses: { 200: Item${r}, 404: NotFound, 409: Conflict },
    },
    searchItems${r}: {
      method: "GET",
      path: "/r${r}/search",
      security: [],
      query: T.Object({
        q: T.String({ minLength: 1 }),
        tags: T.Optional(T.Array(T.String())),
        minPrice: T.Optional(T.Number()),
        maxPrice: T.Optional(T.Number()),
        sort: T.Optional(T.Union([T.Literal("name"), T.Literal("price"), T.Literal("createdAt")])),
      }),
      responses: { 200: ItemList${r} },
    },
    exportItems${r}: {
      method: "GET",
      path: "/r${r}/export",
      security: [{ bearer: ["r${r}:admin"] }],
      cookies: T.Object({ session: T.Optional(T.String()) }),
      responses: {
        200: {
          description: "CSV export",
          body: T.String(),
          mediaType: "text/csv",
          headers: T.Object({ "content-disposition": T.String() }),
        },
      },
    },
    // ops:end
  },
});
`;
}

function handlersFile(r: number): string {
  return `import { type Handler, implement, notImplemented, problem, type Static } from "../../../lib/hyapi.ts";
import type { Deps } from "../shared.ts";
import { contract${r} } from "./contract.ts";
import type { Item${r} } from "./schemas.ts";

type Item = Static<typeof Item${r}>;

// A handler defined outside implement(), typed with Handler<>.
export const getItem${r}: Handler<typeof contract${r}, "getItem${r}"> = async ({ params }, ctx) => {
  const item = await ctx.request.json().catch(() => undefined) as Item | undefined;
  return item && item.id === params.id
    ? { status: 200, body: item }
    : { status: 404, body: problem({ title: "Not found", detail: params.id }) };
};

export const implementation${r} = (deps: Deps<Item>) =>
  implement(contract${r}, {
    // handlers:start
    listItems${r}: async ({ query }) => {
      const items = await deps.list(query.offset ?? 0, query.limit ?? 20);
      return { status: 200, body: { items, total: items.length } };
    },
    getItem${r},
    createItem${r}: async ({ body }, ctx) => {
      if (body.name.length === 0) {
        return { status: 422, body: problem({ title: "Invalid", detail: ctx.operationId }) };
      }
      const item = await deps.create({ ...body, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
      return { status: 201, body: item, headers: { location: \`/r${r}/items/\${item.id}\` } };
    },
    updateItem${r}: async ({ params, body }) => {
      const current = await deps.find(params.id);
      if (!current) return { status: 404, body: problem({ title: "Not found" }) };
      return { status: 200, body: { ...current, ...body } };
    },
    replaceItem${r}: async ({ params, headers, body }) => {
      if (headers["if-match"] === "stale") return { status: 412 };
      const current = await deps.find(params.id);
      return current
        ? { status: 200, body: { ...body, id: current.id, createdAt: current.createdAt } }
        : { status: 404, body: problem({ title: "Not found" }) };
    },
    deleteItem${r}: async ({ params }) => {
      return (await deps.remove(params.id))
        ? { status: 204 }
        : { status: 404, body: problem({ title: "Not found" }) };
    },
    getChild${r}: ({ params }) => ({
      status: 200,
      body: { id: params.childId, parentId: params.id, label: "child", position: 0 },
    }),
    archiveItem${r}: async ({ params, body }, ctx) => {
      const subject = ctx.security.bearer.subject;
      const current = await deps.find(params.id);
      if (!current) return { status: 404, body: problem({ title: "Not found", detail: subject }) };
      return {
        status: 200,
        body: { ...current, status: "archived", ...(body?.reason ? { description: body.reason } : {}) },
      };
    },
    searchItems${r}: async ({ query }) => {
      const items = (await deps.list(0, 100)).filter((item) =>
        item.name.includes(query.q) && (query.minPrice === undefined || item.price >= query.minPrice)
      );
      return { status: 200, body: { items, total: items.length } };
    },
    exportItems${r}: notImplemented,
    // handlers:end
  });
`;
}

function sharedFile(): string {
  return `import { apiKey, defineResponse, defineSecurity, httpBearer, Problem } from "../../lib/hyapi.ts";

export const security = defineSecurity({
  bearer: httpBearer<{ subject: string; tenant: string }>(),
  key: apiKey<{ client: string }>({ in: "header", name: "x-api-key" }),
});

export const NotFound = defineResponse("NotFound", { description: "Not found", body: Problem });
export const Conflict = defineResponse("Conflict", { description: "Conflict", body: Problem });
export const ValidationFailed = defineResponse("ValidationFailed", {
  description: "Validation failed",
  body: Problem,
});

export interface Deps<T> {
  list(offset: number, limit: number): Promise<T[]>;
  find(id: string): Promise<T | undefined>;
  create(value: T): Promise<T>;
  remove(id: string): Promise<boolean>;
}
`;
}

function apiFile(resources: number): string {
  const imports = Array.from(
    { length: resources },
    (_, r) => `import { contract${r} } from "./r${r}/contract.ts";`,
  ).join("\n");
  const list = Array.from({ length: resources }, (_, r) => `contract${r}`).join(", ");
  return `import { defineApi } from "../../lib/hyapi.ts";
import { security } from "./shared.ts";
${imports}

export const api = defineApi({
  info: { title: "Generated", version: "1.0.0" },
  securitySchemes: security,
  contracts: [${list}],
});
`;
}

function mainFile(resources: number): string {
  const imports = Array.from(
    { length: resources },
    (_, r) => `import { implementation${r} } from "./r${r}/handlers.ts";`,
  ).join("\n");
  const impls = Array.from({ length: resources }, (_, r) => `    implementation${r}(deps()),`).join(
    "\n",
  );
  return `import { createApp } from "../../lib/hyapi.ts";
import type { Deps } from "./shared.ts";
import { api } from "./api.ts";
import "./bust.ts";
${imports}

// deno-lint-ignore no-explicit-any
const deps = (): Deps<any> => ({
  list: () => Promise.resolve([]),
  find: () => Promise.resolve(undefined),
  create: (value) => Promise.resolve(value),
  remove: () => Promise.resolve(false),
});

export const app = await createApp({
  api,
  implementations: [
${impls}
  ],
  verifiers: {
    bearer: () => ({ identity: { subject: "s", tenant: "t" }, scopes: [] }),
    key: () => ({ identity: { client: "c" }, scopes: [] }),
  },
});
`;
}

const NAMES = [
  "listItems",
  "getItem",
  "createItem",
  "updateItem",
  "replaceItem",
  "deleteItem",
  "getChild",
  "archiveItem",
  "searchItems",
  "exportItems",
];

// Repeats the marked block `copies` times with renamed operations and paths, producing a contract
// (and implementation) of OPS_PER_RESOURCE * copies operations.
function widen(text: string, r: number, copies: number, marker: string): string {
  if (copies === 1) return text;
  const start = text.indexOf(`// ${marker}:start`);
  const end = text.indexOf(`// ${marker}:end`);
  const block = text.slice(start, end);
  let blocks = block;
  for (let k = 1; k < copies; k++) {
    let copy = block.replace(`getItem${r},`, `getItem${r}: notImplemented,`);
    for (const name of NAMES) copy = copy.replaceAll(`${name}${r}:`, `${name}${r}k${k}:`);
    copy = copy.replaceAll(`/r${r}/`, `/r${r}k${k}/`).replaceAll(
      `"getItem${r}"`,
      `"getItem${r}k${k}"`,
    );
    blocks += copy;
  }
  return text.slice(0, start) + blocks + text.slice(end);
}

async function generate(spec: string): Promise<void> {
  const [operationsText, copiesText] = spec.split(":");
  const operations = Number(operationsText);
  const copies = Number(copiesText ?? "1");
  const resources = Math.ceil(operations / (OPS_PER_RESOURCE * copies));
  const root = copies === 1
    ? `gen/n${operations}`
    : `gen/n${operations}w${copies * OPS_PER_RESOURCE}`;
  await Deno.remove(root, { recursive: true }).catch(() => {});
  for (let r = 0; r < resources; r++) {
    await Deno.mkdir(`${root}/r${r}`, { recursive: true });
    await Deno.writeTextFile(`${root}/r${r}/schemas.ts`, schemasFile(r));
    await Deno.writeTextFile(`${root}/r${r}/contract.ts`, widen(contractFile(r), r, copies, "ops"));
    await Deno.writeTextFile(
      `${root}/r${r}/handlers.ts`,
      widen(handlersFile(r), r, copies, "handlers"),
    );
  }
  await Deno.writeTextFile(`${root}/shared.ts`, sharedFile());
  await Deno.writeTextFile(`${root}/api.ts`, apiFile(resources));
  await Deno.writeTextFile(`${root}/main.ts`, mainFile(resources));
  await Deno.writeTextFile(`${root}/bust.ts`, "export const bust = 0;\n");
  const total = resources * OPS_PER_RESOURCE * copies;
  console.log(`generated ${root}: ${resources} contracts, ${total} operations`);
}

for (const arg of Deno.args) await generate(arg);
