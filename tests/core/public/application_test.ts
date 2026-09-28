import { assert, assertEquals } from "@std/assert";
import {
  createApplication,
  defineConfig,
  definePort,
  type Module,
  NotFoundError,
  providePort,
} from "@hyapi/core";
import Type from "typebox";

interface UserDirectory {
  find(id: string): Promise<{ id: string } | null>;
}

Deno.test("the public application facade composes ports, routes, and problem responses", async () => {
  const userDirectory = definePort<UserDirectory>("users.directory");
  const ordersModule: Module = {
    name: "orders",
    requires: [userDirectory],
    setup(module) {
      const users = module.use(userDirectory);
      module.route({
        method: "get",
        path: "/orders/{id}",
        request: { params: Type.Object({ id: Type.String() }) },
        responses: { 200: Type.Object({ id: Type.String() }) },
        handler: async ({ params, ok }) => {
          const user = await users.find(params.id);
          if (!user) throw new NotFoundError();
          return ok(user);
        },
      });
    },
  };
  const app = await createApplication({
    config: defineConfig({ name: "public-contract" }),
    modules: [ordersModule],
    providers: [providePort(userDirectory, { find: async (id) => id === "ada" ? { id } : null })],
  });

  const found = await app.request("http://test/orders/ada");
  assertEquals(found.status, 200);
  assertEquals(await found.json(), { id: "ada" });

  const missing = await app.request("http://test/orders/missing");
  assertEquals(missing.status, 404);
  assertEquals(missing.headers.get("content-type"), "application/problem+json");
  assertEquals((await missing.json()).code, "NOT_FOUND");
  await app.close();
});

Deno.test("the public configuration facade selects routes for each OpenAPI document", async () => {
  const app = await createApplication({
    config: defineConfig({
      name: "multiple-documents",
      openapi: {
        defaultDocument: "public",
        documents: [
          { id: "public", path: "/openapi.json" },
          { id: "internal", path: "/internal/openapi.json" },
        ],
      },
    }),
    modules: [{
      name: "documents",
      setup(module) {
        module.route({
          method: "get",
          path: "/shared",
          handler: ({ ok }) => ok({ route: "shared" }),
        });
        module.route({
          method: "get",
          path: "/internal",
          metadata: { documentIds: ["internal"] },
          handler: ({ ok }) => ok({ route: "internal" }),
        });
      },
    }],
  });

  const publicDocument = await (await app.request("http://test/openapi.json")).json();
  assert(publicDocument.paths["/shared"]);
  assertEquals(publicDocument.paths["/internal"], undefined);

  const internalDocument = await (await app.request("http://test/internal/openapi.json")).json();
  assertEquals(internalDocument.paths["/shared"], undefined);
  assert(internalDocument.paths["/internal"]);
  await app.close();
});
