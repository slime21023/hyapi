import { assertEquals } from "@std/assert";
import {
  createApplication,
  defineConfig,
  defineHttpContract,
  defineRoute,
  type Module,
  NotFoundError,
  registerHttpContract,
} from "@hyapi/core";
import Type from "typebox";

const Item = Type.Object({ id: Type.String(), name: Type.String() });
const Missing = Type.Object({ message: Type.String() });

/** Never registered: these routes exist only so `deno check` verifies the compile-time contract. */
export const compileTimeContract: Module = {
  name: "compile-time",
  setup(module) {
    module.route({
      method: "get",
      path: "/wrong-shape",
      responses: { 200: Item },
      // @ts-expect-error `id` must be a string and `name` is required.
      handler: ({ ok }) => ok({ id: 1 }),
    });
    module.route({
      method: "get",
      path: "/undeclared-status",
      responses: { 200: Item },
      // @ts-expect-error 404 is not a declared status.
      handler: ({ json }) => json({ message: "missing" }, 404),
    });
    module.route({
      method: "delete",
      path: "/undeclared-no-content",
      responses: { 200: Item },
      // @ts-expect-error 204 is not a declared status.
      handler: ({ noContent }) => noContent(),
    });
    module.route({
      method: "get",
      path: "/bare-wrong-shape",
      responses: { 200: Item },
      // @ts-expect-error a bare body must match a declared response.
      handler: () => ({ id: "1" }),
    });
  },
};

const itemsContract = defineHttpContract({
  name: "items",
  version: { major: 1, minor: 0 },
  routes: {
    getItem: {
      method: "get",
      path: "/items/{id}",
      request: { params: Type.Object({ id: Type.String() }) },
      responses: { 200: Item, 404: Missing },
    },
  },
});

/** Never registered: contract handlers are checked against the contract's responses. */
export const compileTimeContractHandlers: Module = {
  name: "compile-time-contract",
  setup(module) {
    registerHttpContract(module, itemsContract, {
      // @ts-expect-error `name` is required by the contract's 200 response.
      getItem: ({ params, ok }) => ok({ id: params.id }),
    });
  },
};

const getItem = defineRoute({
  method: "get",
  path: "/items/{id}",
  request: { params: Type.Object({ id: Type.String() }) },
  responses: { 200: Item, 404: Missing },
  handler: ({ params, ok, json }) =>
    params.id === "missing"
      ? json({ message: "Item was not found." }, 404)
      : ok({ id: params.id, name: "Book" }),
});

Deno.test("declared responses type helper results and defineRoute keeps inference", async () => {
  const app = await createApplication({
    config: defineConfig({ name: "response-types" }),
    modules: [{
      name: "items",
      setup(module) {
        module.route(getItem);
        module.route({
          method: "delete",
          path: "/items/{id}",
          responses: { 204: Type.Null() },
          handler: ({ noContent }) => noContent(),
        });
        registerHttpContract(
          module,
          defineHttpContract({
            name: "catalog",
            version: { major: 1, minor: 0 },
            routes: {
              getEntry: {
                method: "get",
                path: "/catalog/{id}",
                request: { params: Type.Object({ id: Type.String() }) },
                responses: { 200: Item },
              },
            },
          }),
          {
            getEntry: ({ params, ok }) => {
              if (params.id === "none") throw new NotFoundError();
              return ok({ id: params.id, name: "Entry" });
            },
          },
        );
        // Without declared responses, handlers stay untyped.
        module.route({ method: "get", path: "/loose", handler: ({ ok }) => ok({ anything: 1 }) });
      },
    }],
  });

  assertEquals(await (await app.request("/items/1")).json(), { id: "1", name: "Book" });
  const missing = await app.request("/items/missing");
  assertEquals([missing.status, await missing.json()], [404, { message: "Item was not found." }]);
  assertEquals((await app.request("/items/1", { method: "DELETE" })).status, 204);
  assertEquals(await (await app.request("/catalog/7")).json(), { id: "7", name: "Entry" });
  assertEquals(await (await app.request("/loose")).json(), { anything: 1 });
  await app.close();
});
