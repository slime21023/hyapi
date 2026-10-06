import { assertEquals, assertRejects } from "@std/assert";
import {
  anyOf,
  ConfigurationError,
  createApplication,
  defineConfig,
  defineGuard,
  type Guard,
  type Identity,
  type Module,
  requireScopes,
  UnauthorizedError,
} from "@hyapi/core";
import Type from "typebox";

const config = defineConfig({ name: "guards" });

/** Accepts `x-api-key: <subject>:<scope,scope>`; rejects other keys. */
function apiKey(options: { optional?: boolean; scheme?: string } = {}): Guard {
  const scheme = options.scheme ?? "apiKey";
  return defineGuard({
    name: "apiKey",
    security: {
      schemes: { [scheme]: { type: "apiKey", in: "header", name: "x-api-key" } },
      ...(options.optional ? { optional: true } : {}),
    },
    check({ request }): Identity | void {
      const key = request.headers.get("x-api-key");
      if (key === null) {
        if (options.optional) return;
        throw new UnauthorizedError(undefined, { challenge: "ApiKey" });
      }
      const separator = key.indexOf(":");
      const subject = separator < 0 ? key : key.slice(0, separator);
      const scopes = separator < 0 ? "" : key.slice(separator + 1);
      if (!subject) throw new UnauthorizedError(undefined, { challenge: "ApiKey" });
      return { subject, scopes: scopes ? scopes.split(",") : [], claims: { source: "api-key" } };
    },
  });
}

const sessionCookie = defineGuard({
  name: "session",
  security: { schemes: { session: { type: "apiKey", in: "cookie", name: "sid" } } },
  check({ request }) {
    const cookie = request.headers.get("cookie");
    if (cookie !== "sid=ada") throw new UnauthorizedError();
    return { subject: "ada", scopes: ["orders:read"], claims: {} };
  },
});

/** Opaque authorization: only the owner named in the raw path may continue. */
const ownsOrder = defineGuard({
  name: "ownsOrder",
  check({ identity, params }) {
    if (identity?.subject !== params.owner) throw new UnauthorizedError("Not your order.");
  },
});

function module(setup: Module["setup"]): Module {
  return { name: "guarded", setup };
}

Deno.test("guards run before validation, so unauthenticated requests get 401 before 400", async () => {
  let bodyRead = false;
  const app = await createApplication({
    config,
    modules: [module((api) => {
      api.route({
        method: "post",
        path: "/orders",
        guards: [apiKey()],
        request: { body: Type.Object({ item: Type.String() }) },
        handler: ({ body, identity, ok }) => {
          bodyRead = true;
          return ok({ item: body.item, subject: identity?.subject });
        },
      });
    })],
  });

  const anonymous = await app.request("/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assertEquals(anonymous.status, 401);
  assertEquals(anonymous.headers.get("www-authenticate"), "ApiKey");
  assertEquals(bodyRead, false);

  const invalid = await app.request("/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "ada:" },
    body: JSON.stringify({}),
  });
  assertEquals(invalid.status, 400);

  const accepted = await app.request("/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "ada:" },
    body: JSON.stringify({ item: "book" }),
  });
  assertEquals(await accepted.json(), { item: "book", subject: "ada" });
  await app.close();
});

Deno.test("group guards are inherited before route guards, and requireScopes maps to 401/403", async () => {
  const order: string[] = [];
  const trace = (name: string) => defineGuard({ name, check: () => void order.push(name) });
  const app = await createApplication({
    config,
    modules: [module((api) => {
      api.group({ prefix: "/v1", guards: [trace("outer"), apiKey({ optional: true })] }, (v1) => {
        v1.group({ guards: [trace("inner")] }, (inner) => {
          inner.route({
            method: "get",
            path: "/reports",
            guards: [trace("route"), requireScopes("reports:read")],
            handler: ({ identity, ok }) => ok({ subject: identity?.subject }),
          });
        });
      });
    })],
  });

  assertEquals((await app.request("/v1/reports")).status, 401);
  assertEquals(order, ["outer", "inner", "route"]);
  assertEquals(
    (await app.request("/v1/reports", { headers: { "x-api-key": "ada:" } })).status,
    403,
  );
  const allowed = await app.request("/v1/reports", {
    headers: { "x-api-key": "ada:reports:read" },
  });
  assertEquals(allowed.status, 200);
  assertEquals(await allowed.json(), { subject: "ada" });
  await app.close();
});

Deno.test("anyOf accepts the first passing alternative and rethrows the first rejection", async () => {
  const app = await createApplication({
    config,
    modules: [module((api) => {
      api.route({
        method: "get",
        path: "/orders/{owner}",
        guards: [anyOf(apiKey(), sessionCookie), ownsOrder],
        handler: ({ identity, ok }) => ok({ subject: identity?.subject }),
      });
    })],
  });

  const viaCookie = await app.request("/orders/ada", { headers: { cookie: "sid=ada" } });
  assertEquals(await viaCookie.json(), { subject: "ada" });
  const viaKey = await app.request("/orders/bob", { headers: { "x-api-key": "bob:" } });
  assertEquals(await viaKey.json(), { subject: "bob" });

  const neither = await app.request("/orders/ada");
  assertEquals(neither.status, 401);
  assertEquals(neither.headers.get("www-authenticate"), "ApiKey");

  const notOwner = await app.request("/orders/ada", { headers: { "x-api-key": "bob:" } });
  assertEquals(notOwner.status, 401);
  assertEquals((await notOwner.json()).detail, "Not your order.");
  await app.close();
});

Deno.test("a second identity in one chain is a hidden configuration error", async () => {
  const app = await createApplication({
    config,
    modules: [module((api) => {
      api.route({
        method: "get",
        path: "/twice",
        guards: [apiKey(), sessionCookie],
        handler: ({ ok }) => ok({}),
      });
    })],
  });
  const response = await app.request("/twice", {
    headers: { "x-api-key": "ada:", cookie: "sid=ada" },
  });
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, "CONFIGURATION_ERROR");
  await app.close();
});

Deno.test("OpenAPI security is projected from guards without a hardcoded scheme", async () => {
  const app = await createApplication({
    config,
    modules: [module((api) => {
      api.route({ method: "get", path: "/public", handler: ({ ok }) => ok({}) });
      api.route({
        method: "get",
        path: "/either",
        guards: [anyOf(apiKey(), sessionCookie), requireScopes("orders:read")],
        handler: ({ ok }) => ok({}),
      });
      api.route({
        method: "get",
        path: "/maybe",
        guards: [apiKey({ optional: true })],
        handler: ({ ok }) => ok({}),
      });
      api.route({
        method: "get",
        path: "/opaque",
        guards: [ownsOrder],
        handler: ({ ok }) => ok({}),
      });
    })],
  });
  const document = await (await app.request("/openapi.json")).json();
  assertEquals(document.components.securitySchemes, {
    apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
    session: { type: "apiKey", in: "cookie", name: "sid" },
  });

  const publicOperation = document.paths["/public"].get;
  assertEquals(publicOperation.security, undefined);
  assertEquals(publicOperation.responses["401"], undefined);

  const either = document.paths["/either"].get;
  assertEquals(either.security, [{ apiKey: ["orders:read"] }, { session: ["orders:read"] }]);
  assertEquals(Object.keys(either.responses).includes("401"), true);
  assertEquals(Object.keys(either.responses).includes("403"), true);

  const maybe = document.paths["/maybe"].get;
  assertEquals(maybe.security, [{ apiKey: [] }, {}]);
  assertEquals(maybe.responses["403"], undefined);

  const opaque = document.paths["/opaque"].get;
  assertEquals(opaque.security, undefined);
  assertEquals(Object.keys(opaque.responses).includes("403"), true);
  await app.close();
});

Deno.test("conflicting security scheme definitions fail startup", async () => {
  await assertRejects(
    () =>
      createApplication({
        config,
        modules: [module((api) => {
          api.route({ method: "get", path: "/a", guards: [apiKey()], handler: () => "a" });
          api.route({
            method: "get",
            path: "/b",
            guards: [defineGuard({
              name: "other",
              security: { schemes: { apiKey: { type: "http", scheme: "basic" } } },
              check: () => {},
            })],
            handler: () => "b",
          });
        })],
      }),
    ConfigurationError,
    "OpenAPI security scheme 'apiKey' is declared with different definitions.",
  );
});
