import Type from "typebox";
import { createApplication, defineConfig, jwtPlugin, type Module } from "@hyapi/core";

const SECRET = "bench-secret-with-at-least-32-characters!!";

const ItemSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  limit: Type.Integer(),
}, { additionalProperties: false });

const itemsModule: Module = {
  name: "items",
  setup(module) {
    module.route({
      method: "get",
      path: "/items/{id}",
      request: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        query: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
        }),
      },
      responses: { 200: ItemSchema },
      handler: ({ params, query, ok }) =>
        ok({ id: params.id, name: "item", limit: query.limit ?? 20 }),
    });
    module.route({
      method: "post",
      path: "/items",
      request: {
        body: Type.Object({
          name: Type.String({ minLength: 1 }),
          limit: Type.Integer({ minimum: 1 }),
        }, { additionalProperties: false }),
      },
      responses: { 201: ItemSchema },
      handler: ({ body, created }) => created({ id: "new", name: body.name, limit: body.limit }),
    });
    module.route({
      method: "get",
      path: "/secure",
      auth: { scopes: ["items:read"] },
      responses: { 200: Type.Object({ ok: Type.Boolean() }) },
      handler: ({ ok }) => ok({ ok: true }),
    });
  },
};

const app = await createApplication({
  config: defineConfig({ name: "bench", environment: "production" }),
  modules: [itemsModule],
  plugins: [jwtPlugin({ secret: SECRET })],
});

const token = await createToken(SECRET, ["items:read"]);
const postBody = JSON.stringify({ name: "widget", limit: 5 });

Deno.bench("GET with params+query validation", async () => {
  await (await app.request("http://bench/items/abc?limit=10")).arrayBuffer();
});

Deno.bench("POST JSON body validation", async () => {
  await (await app.request("http://bench/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: postBody,
  })).arrayBuffer();
});

Deno.bench("JWT-protected GET", async () => {
  await (await app.request("http://bench/secure", {
    headers: { authorization: `Bearer ${token}` },
  })).arrayBuffer();
});

Deno.bench("OpenAPI document (cached)", async () => {
  await (await app.request("http://bench/openapi.json")).arrayBuffer();
});

async function createToken(secretValue: string, scopes: readonly string[]): Promise<string> {
  const encode = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ alg: "HS256", typ: "JWT" });
  const claims = encode({
    sub: "bench-user",
    scope: scopes.join(" "),
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
