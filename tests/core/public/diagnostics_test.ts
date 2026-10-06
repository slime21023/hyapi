import { assertEquals } from "@std/assert";
import { type AppConfigOptions, createApplication, defineConfig, type Module } from "@hyapi/core";
import Type from "typebox";

const failing: Module = {
  name: "failing",
  setup(module) {
    module.route({
      method: "get",
      path: "/boom",
      handler: () => {
        throw new TypeError("database handle is closed");
      },
    });
    module.route({
      method: "get",
      path: "/contract",
      responses: { 200: Type.Object({ id: Type.String() }) },
      handler: ({ json }) => json({ id: "1" }, 202 as 200),
    });
  },
};

async function problem(environment: AppConfigOptions["environment"], path: string) {
  const app = await createApplication({
    config: defineConfig({ name: "diagnostics", ...(environment ? { environment } : {}) }),
    modules: [failing],
  });
  const response = await app.request(path);
  const body = await response.json();
  await app.close();
  return { status: response.status, body };
}

Deno.test("defineConfig defaults to production so internal errors stay hidden", async () => {
  assertEquals(defineConfig({ name: "defaults" }).environment, "production");
  const { status, body } = await problem(undefined, "/boom");
  assertEquals(status, 500);
  assertEquals(body.detail, "An unexpected error occurred.");
  assertEquals(body.details, undefined);
});

Deno.test("development problems expose internal messages and details", async () => {
  const thrown = await problem("development", "/boom");
  assertEquals(thrown.status, 500);
  assertEquals(thrown.body.code, "INTERNAL_ERROR");
  assertEquals(thrown.body.detail, "database handle is closed");
  assertEquals(thrown.body.details.name, "TypeError");
  assertEquals(typeof thrown.body.details.stack, "string");

  const contract = await problem("development", "/contract");
  assertEquals(contract.body.code, "RESPONSE_CONTRACT_ERROR");
  assertEquals(contract.body.detail, "Response status 202 is not declared for 'GET /contract'.");
  assertEquals(contract.body.details, { status: 202, declaredStatuses: [200] });
});

Deno.test("test and production problems keep internal errors hidden", async () => {
  for (const environment of ["test", "production"] as const) {
    const { body } = await problem(environment, "/boom");
    assertEquals(body.detail, "An unexpected error occurred.");
    assertEquals(body.details, undefined);
  }
});

Deno.test("default status follows the body: 204 without one, 201 for POST, otherwise 200", async () => {
  const app = await createApplication({
    config: defineConfig({ name: "status" }),
    modules: [{
      name: "items",
      setup(module) {
        module.route({ method: "delete", path: "/items/{id}", handler: () => ({ deleted: true }) });
        module.route({ method: "delete", path: "/quiet/{id}", handler: () => undefined });
        module.route({ method: "post", path: "/items", handler: () => ({ id: "1" }) });
        module.route({ method: "put", path: "/items/{id}", handler: () => ({ id: "1" }) });
      },
    }],
  });
  const deleted = await app.request("/items/1", { method: "DELETE" });
  assertEquals([deleted.status, await deleted.json()], [200, { deleted: true }]);
  assertEquals((await app.request("/quiet/1", { method: "DELETE" })).status, 204);
  const created = await app.request("/items", { method: "POST" });
  assertEquals(created.status, 201);
  await created.body?.cancel();
  const updated = await app.request("/items/1", { method: "PUT" });
  assertEquals(updated.status, 200);
  await updated.body?.cancel();

  const document = await (await app.request("/openapi.json")).json();
  assertEquals(Object.keys(document.paths["/items/{id}"].delete.responses).sort(), ["200", "204"]);
  await app.close();
});
