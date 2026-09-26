import { assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../../../../packages/core/src/app.ts";
import { AppError } from "@hyapi/core";
import { defineConfig, defineRoute, provideValue } from "@hyapi/core";
import type { ServiceResolver } from "../../../../packages/core/src/types.ts";

Deno.test("named overrides obey request and application service lifetimes", async () => {
  const app = createApp({
    config: defineConfig({ name: "override-lifetime", openapi: { enabled: false } }),
    overrides: [
      provideValue("request-dependency", { id: "request" }),
      provideValue("singleton-dependency", { id: "singleton" }),
    ],
  });
  const request = app.requestService("request-dependency", () => ({ id: "factory-request" }));
  const singleton = app.singletonService(
    "singleton-dependency",
    () => ({ id: "factory-singleton" }),
  );
  let resolver: ServiceResolver | undefined;
  let active: string[] = [];
  app.route(defineRoute({
    method: "get",
    path: "/capture",
    handler: async ({ services }) => {
      resolver = services;
      active = [(await services.get(request)).id, (await services.get(singleton)).id];
      return new Response(null, { status: 204 });
    },
  }));
  await app.start();
  assertEquals((await app.request("/capture")).status, 204);
  assertEquals(active, ["request", "singleton"]);

  const afterRequest = await assertRejects(() => resolver!.get(request), AppError);
  assertEquals(afterRequest.code, "SCOPE_CLOSED");
  await app.close();
  const afterClose = await assertRejects(() => resolver!.get(singleton), AppError);
  assertEquals(afterClose.code, "SCOPE_CLOSED");
});

Deno.test("singleton factories cannot resolve overridden request services", async () => {
  const app = createApp({
    config: defineConfig({ name: "override-scope", openapi: { enabled: false } }),
    overrides: [provideValue("request-dependency", { id: "request" })],
  });
  const request = app.requestService("request-dependency", () => ({ id: "factory-request" }));
  const singleton = app.singletonService(async (services) => await services.get(request));
  app.route(defineRoute({
    method: "get",
    path: "/scope",
    handler: async ({ services, ok }) => ok(await services.get(singleton)),
  }));
  await app.start();
  const response = await app.request("/scope");
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, "CONFIGURATION_ERROR");
  await app.close();
});
