// Routing cost as the number of operations grows. Results: _adr/baselines/routing.md.
//
// Each resource r declares five operations, three of them under `/r{r}/items/{id}`, so every
// resource adds one pattern to the same three-segment bucket that the router scans linearly.
// Comparing the first and last pattern of that bucket shows the cost of the scan; a 404 shows
// routing alone.
import Type from "typebox";
import { type App, createApp, implement } from "@hyapi/core";
import { defineApi, defineContract, defineSchema } from "@hyapi/core/contract";

const T = Type;
const Ok = defineSchema("Ok", T.Object({ ok: T.Boolean() }));
const Id = T.Object({ id: T.String() });
const SIZES = [50, 500, 2000] as const;
const OPERATIONS_PER_RESOURCE = 5;

async function buildApp(operations: number): Promise<{ app: App; resources: number }> {
  const resources = operations / OPERATIONS_PER_RESOURCE;
  const declared: Record<string, unknown> = {};
  const handlers: Record<string, () => unknown> = {};
  const ok = () => ({ status: 200, body: { ok: true } });
  for (let r = 0; r < resources; r++) {
    const base = `/r${r}/items`;
    Object.assign(declared, {
      [`list${r}`]: { method: "GET", path: base, responses: { 200: Ok } },
      [`create${r}`]: { method: "POST", path: base, responses: { 200: Ok } },
      [`get${r}`]: { method: "GET", path: `${base}/{id}`, params: Id, responses: { 200: Ok } },
      [`update${r}`]: { method: "PATCH", path: `${base}/{id}`, params: Id, responses: { 200: Ok } },
      [`delete${r}`]: {
        method: "DELETE",
        path: `${base}/{id}`,
        params: Id,
        responses: { 200: Ok },
      },
    });
    for (const name of ["list", "create", "get", "update", "delete"]) handlers[`${name}${r}`] = ok;
  }
  const contract = defineContract({ operations: declared as never });
  const app = await createApp({
    api: defineApi({ info: { title: "Routing", version: "1" }, contracts: [contract] }),
    implementations: [implement(contract, handlers as never)],
    onEvent: () => {},
  });
  return { app, resources };
}

for (const size of SIZES) {
  const { app, resources } = await buildApp(size);
  const call = async (path: string) => {
    await (await app.fetch(new Request(`http://bench${path}`))).text();
  };
  const group = `${size} operations`;
  Deno.bench(`${group}: first pattern (/r0/items/x)`, { group, baseline: true }, async () => {
    await call("/r0/items/x");
  });
  Deno.bench(`${group}: last pattern (/r${resources - 1}/items/x)`, { group }, async () => {
    await call(`/r${resources - 1}/items/x`);
  });
  Deno.bench(`${group}: literal path (/r${resources - 1}/items)`, { group }, async () => {
    await call(`/r${resources - 1}/items`);
  });
  Deno.bench(`${group}: 404 in the same bucket`, { group }, async () => {
    await call("/none/items/x");
  });
}
