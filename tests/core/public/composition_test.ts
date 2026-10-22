import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, type ApplicationOptions } from "hyapi";

type Modules = ApplicationOptions<Container>["modules"];

function compose(modules: Modules) {
  return createApp({ container: new Container(), modules });
}

const authenticate = () => ({ subject: "owner" });

test("composition rejects invalid module declarations before accepting traffic", () => {
  const cases: [label: string, modules: Modules, message: RegExp][] = [
    [
      "duplicate module name",
      ({ module }) => [
        module({ name: "a", prefix: "/a", routes: () => [] }),
        module({ name: "a", prefix: "/b", routes: () => [] }),
      ],
      /Module 'a' is registered twice/,
    ],
    [
      "blank module name",
      ({ module }) => [module({ name: "", prefix: "/a", routes: () => [] })],
      /need a name and an absolute path prefix/,
    ],
    [
      "relative prefix",
      ({ module }) => [module({ name: "a", prefix: "a", routes: () => [] })],
      /need a name and an absolute path prefix/,
    ],
    [
      "prefix with a trailing slash",
      ({ module }) => [module({ name: "a", prefix: "/a/", routes: () => [] })],
      /prefix cannot end in '\/'/,
    ],
    [
      "public module declaring security",
      ({ module }) => [
        module({ name: "a", prefix: "/a", security: "BearerAuth", routes: () => [] } as never),
      ],
      /Public module 'a' cannot declare security/,
    ],
  ];
  for (const [label, modules, message] of cases) {
    assert.throws(() => compose(modules), message, label);
  }
});

test("composition rejects invalid route declarations", () => {
  const route =
    (declare: Parameters<Parameters<Modules>[0]["module"]>[0]["routes"]): Modules =>
    ({ module }) => [module({ name: "a", prefix: "/a", routes: declare })];
  const cases: [label: string, modules: Modules, message: RegExp][] = [
    ["relative path", route((r) => [r.get("x", { handler: () => 1 })]), /must start with '\/'/],
    ["missing handler", route((r) => [r.get("/", {} as never)]), /Route '\/' needs a handler/],
    [
      "unsupported segment",
      route((r) => [r.get("/*", { handler: () => 1 })]),
      /Unsupported route segment '\*'/,
    ],
    [
      "non Standard Schema v1",
      route((r) => [r.post("/", { body: { parse() {} } as never, handler: () => 1 })]),
      /needs a Standard Schema v1 schema/,
    ],
    [
      "non Standard Schema v1 response map entry",
      route((r) => [r.get("/", { response: { 201: {} as never }, handler: () => 1 as never })]),
      /needs a Standard Schema v1 schema/,
    ],
    [
      "duplicate full path across modules",
      ({ module }) => [
        module({ name: "a", prefix: "/a", routes: (r) => [r.get("/b/c", { handler: () => 1 })] }),
        module({ name: "b", prefix: "/a/b", routes: (r) => [r.get("/c", { handler: () => 2 })] }),
      ],
      /Route 'GET \/a\/b\/c' is registered twice/,
    ],
    [
      "duplicate method and path",
      ({ module }) => [
        module({ name: "a", prefix: "/a", routes: (r) => [r.get("/b", { handler: () => 1 })] }),
        module({ name: "b", prefix: "/a", routes: (r) => [r.get("/b", { handler: () => 2 })] }),
      ],
      /Route 'GET \/a\/b' is registered twice/,
    ],
    [
      "case-only overlap with a different authentication policy",
      ({ module }) => [
        module({
          name: "a",
          prefix: "/v1",
          routes: (r) => [r.get("/Items", { handler: () => 1 })],
        }),
        module({
          name: "b",
          prefix: "/v1",
          authenticate,
          routes: (r) => [r.get("/items", { handler: () => 2 })],
        }),
      ],
      /Overlapping routes/,
    ],
  ];
  for (const [label, modules, message] of cases) {
    assert.throws(() => compose(modules), message, label);
  }
});

test("composition accepts overlaps that share one authentication policy", async () => {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "root",
        prefix: "/",
        routes: (route) => [route.get("/", { handler: () => "root" })],
      }),
      module({
        name: "items",
        prefix: "/items",
        authenticate,
        routes: (route) => [
          route.get("/me", { handler: () => "me" }),
          route.get("/:id", {
            params: v.object({ id: v.string() }),
            handler: ({ params }) => params.id,
          }),
          route.delete("/:id", { handler: () => "deleted" }),
        ],
      }),
    ],
  });
  try {
    const send = async (path: string, method = "GET") =>
      (await app.fetch(new Request(`http://localhost${path}`, { method }))).text();
    assert.equal(await send("/"), "root");
    assert.equal(await send("/items/me"), "me");
    assert.equal(await send("/items/42"), "42");
    assert.equal(await send("/items/42", "DELETE"), "deleted");
  } finally {
    await app.close();
    await root.dispose();
  }
});
