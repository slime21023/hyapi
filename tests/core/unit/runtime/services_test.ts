import { assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../../../../packages/core/src/app.ts";
import { defineConfig } from "@hyapi/core";
import type { ServiceResolver } from "../../../../packages/core/src/types.ts";
import { ScopeClosedError } from "../../../../packages/core/src/runtime/scope.ts";

Deno.test("named overrides obey request and application service lifetimes", async () => {
  const closed: string[] = [];
  const app = createApp({
    config: defineConfig({ name: "override-lifetime", openapi: { enabled: false } }),
    overrides: [
      {
        name: "request-dependency",
        value: { id: "request", close: () => void closed.push("request") },
      },
      {
        name: "singleton-dependency",
        value: { id: "singleton", close: () => void closed.push("singleton") },
      },
    ],
  });
  const request = app.requestService("request-dependency", () => ({ id: "factory-request" }));
  const singleton = app.singletonService(
    "singleton-dependency",
    () => ({ id: "factory-singleton" }),
  );
  let resolver: ServiceResolver | undefined;
  let active: string[] = [];
  app.route({
    method: "get",
    path: "/capture",
    handler: async ({ services }) => {
      resolver = services;
      active = [(await services.get(request)).id, (await services.get(singleton)).id];
      return new Response(null, { status: 204 });
    },
  });
  await app.start();
  assertEquals((await app.request("/capture")).status, 204);
  assertEquals(active, ["request", "singleton"]);
  assertEquals(closed, ["request"]);

  const afterRequest = await assertRejects(() => resolver!.get(request), ScopeClosedError);
  assertEquals(afterRequest.code, "SCOPE_CLOSED");
  await app.close();
  assertEquals(closed, ["request", "singleton"]);
  const afterClose = await assertRejects(() => resolver!.get(singleton), ScopeClosedError);
  assertEquals(afterClose.code, "SCOPE_CLOSED");
});

Deno.test("singleton factories cannot resolve overridden request services", async () => {
  const app = createApp({
    config: defineConfig({ name: "override-scope", openapi: { enabled: false } }),
    overrides: [{ name: "request-dependency", value: { id: "request" } }],
  });
  const request = app.requestService("request-dependency", () => ({ id: "factory-request" }));
  const singleton = app.singletonService(async (services) => await services.get(request));
  app.route({
    method: "get",
    path: "/scope",
    handler: async ({ services, ok }) => ok(await services.get(singleton)),
  });
  await app.start();
  const response = await app.request("/scope");
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, "CONFIGURATION_ERROR");
  await app.close();
});
