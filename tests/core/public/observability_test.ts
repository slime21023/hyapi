import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import Type from "typebox";
import {
  type AppEvent,
  type AppOptions,
  createApp,
  HttpError,
  implement,
  StartupError,
  type VerifierContext,
} from "@hyapi/core";
import {
  apiKey,
  defineApi,
  defineContract,
  defineSchema,
  defineSecurity,
  httpBearer,
} from "@hyapi/core/contract";

const T = Type;
const Who = defineSchema("Who", T.Object({ who: T.String() }));
const security = defineSecurity({
  bearer: httpBearer<{ subject: string }>(),
  key: apiKey<{ client: string }>({ in: "header", name: "x-api-key" }),
});
const contract = defineContract({
  securitySchemes: security,
  operations: {
    open: { method: "GET", path: "/open", security: [], responses: { 200: Who } },
    guarded: {
      method: "GET",
      path: "/guarded",
      security: [{ bearer: ["read"] }, { key: [] }],
      responses: { 200: Who },
    },
    broken: { method: "GET", path: "/broken", security: [], responses: { 200: Who } },
    item: {
      method: "GET",
      path: "/items/{id}",
      security: [],
      params: T.Object({ id: T.String() }),
      responses: { 200: Who },
    },
  },
});
const api = defineApi({
  info: { title: "Observability", version: "1" },
  securitySchemes: security,
  contracts: [contract],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function build(
  options: Partial<AppOptions<typeof api>> & { events?: AppEvent[]; seen?: VerifierContext[] } = {},
) {
  const { events = [], seen = [], ...rest } = options;
  return await createApp({
    api,
    onEvent: (event) => void events.push(event),
    implementations: [
      implement(contract, {
        open: (_, ctx) => ({ status: 200, body: { who: ctx.requestId ?? "none" } }),
        guarded: (_, ctx) => ({ status: 200, body: { who: ctx.requestId ?? "none" } }),
        broken: () => {
          throw new Error("outer", { cause: new TypeError("inner") });
        },
        item: ({ params }) => ({ status: 200, body: { who: params.id } }),
      }),
    ],
    verifiers: {
      bearer: (token, ctx) => {
        seen.push(ctx);
        if (token === "suspended") throw new HttpError(403, { code: "SUSPENDED" });
        if (token === "reader") return { identity: { subject: "r" }, scopes: ["read"] };
        if (token === "nobody") return { identity: { subject: "n" }, scopes: [] };
        return null;
      },
      key: (value) => (value === "k1" ? { identity: { client: "c1" } } : null),
    },
    ...rest,
  });
}

const get = (app: { fetch(r: Request): Promise<Response> }, path: string, headers = {}) =>
  app.fetch(new Request(`http://t${path}`, { headers }));

// --- Request IDs (RFC 0001 A27) ------------------------------------------------------------------

Deno.test("request IDs are off unless requested", async () => {
  const events: AppEvent[] = [];
  const app = await build({ events });
  const response = await get(app, "/open");
  assertEquals(await response.json(), { who: "none" });
  assertEquals(response.headers.get("x-request-id"), null);
  assert(events.every((event) => !("requestId" in event)));
  await app.close();
});

Deno.test("with requestId, each request gets one ID in events, ctx, and the response", async () => {
  const events: AppEvent[] = [];
  const app = await build({ events, requestId: true });
  const response = await get(app, "/open", { "x-request-id": "from-client" });
  const id = response.headers.get("x-request-id")!;
  assertMatch(id, UUID, "incoming IDs are not trusted by default");
  assertEquals(await response.json(), { who: id });
  const scoped = events.filter((event) => event.type.startsWith("operation."));
  assertEquals(scoped.map((event) => "requestId" in event && event.requestId), [id, id]);

  const missing = await get(app, "/nowhere");
  await missing.body?.cancel();
  const unmatched = events.find((event) => event.type === "request.unmatched");
  assertEquals(
    unmatched && "requestId" in unmatched && unmatched.requestId,
    missing.headers.get("x-request-id"),
  );
  await app.close();
});

Deno.test("trusted incoming IDs are reused only when well formed", async () => {
  const app = await build({ requestId: { header: "X-Correlation-Id", trustIncoming: true } });
  const reused = await get(app, "/open", { "x-correlation-id": "trace.42:a-b_c" });
  assertEquals(reused.headers.get("x-correlation-id"), "trace.42:a-b_c");
  await reused.body?.cancel();
  for (const bad of ["has space", "x".repeat(129), "semi;colon"]) {
    const replaced = await get(app, "/open", { "x-correlation-id": bad });
    assertMatch(replaced.headers.get("x-correlation-id")!, UUID);
    await replaced.body?.cancel();
  }
  await app.close();
});

Deno.test("an invalid request ID header name stops startup", async () => {
  const error = await assertRejects(
    () => build({ requestId: { header: "not a header" } }),
    StartupError,
  );
  assertEquals(error.diagnostics.map((d) => d.code), ["invalid-option"]);
});

// --- Security (A28, A29, A31) --------------------------------------------------------------------

Deno.test("denials are events with reason, schemes, and required scopes, never credentials", async () => {
  const events: AppEvent[] = [];
  const app = await build({ events });
  for (const headers of [{}, { authorization: "Bearer bad" }, { authorization: "Bearer nobody" }]) {
    await (await get(app, "/guarded", headers)).body?.cancel();
  }
  const denied = events.filter((event) => event.type === "security.denied");
  assertEquals(
    denied.map((event) =>
      event.type === "security.denied" &&
      [event.status, event.reason, event.schemes, event.requiredScopes]
    ),
    [
      [401, "missing", ["bearer", "key"], undefined],
      [401, "invalid", ["bearer", "key"], undefined],
      [403, "insufficient-scope", ["bearer", "key"], ["read"]],
    ],
  );
  assert(!JSON.stringify(events).includes("nobody"), "tokens never reach events");
  await app.close();
});

Deno.test("verifiers receive the requirement and the request ID", async () => {
  const seen: VerifierContext[] = [];
  const app = await build({ seen, requestId: true });
  const response = await get(app, "/guarded", { authorization: "Bearer reader" });
  assertEquals(seen[0]?.requirements, [{ bearer: ["read"] }, { key: [] }]);
  assertEquals(seen[0]?.requestId, response.headers.get("x-request-id"));
  await response.body?.cancel();
  await app.close();
});

Deno.test("a verifier's HttpError answers with its status and ends evaluation", async () => {
  const seen: VerifierContext[] = [];
  const app = await build({ seen });
  const response = await get(app, "/guarded", {
    authorization: "Bearer suspended",
    "x-api-key": "k1",
  });
  assertEquals([response.status, (await response.json()).code], [403, "SUSPENDED"]);
  await app.close();
});

Deno.test("a 401 for an API key scheme carries an ApiKey challenge", async () => {
  const app = await build();
  const response = await get(app, "/guarded");
  assertEquals(
    response.headers.get("www-authenticate"),
    'Bearer, ApiKey in="header", name="x-api-key"',
  );
  await response.body?.cancel();
  await app.close();
});

// --- Errors and unmatched requests (A30, A32) ----------------------------------------------------

Deno.test("error events carry the stack and the cause", async () => {
  const events: AppEvent[] = [];
  const app = await build({ events });
  const response = await get(app, "/broken");
  assertEquals((await response.json()).detail, undefined, "responses still hide details");
  const end = events.find((event) => event.type === "operation.end");
  const error = end?.type === "operation.end" ? end.error : undefined;
  assertEquals([error?.name, error?.message], ["Error", "outer"]);
  assert(error?.stack?.includes("outer"));
  assertEquals([error?.cause?.name, error?.cause?.message], ["TypeError", "inner"]);
  await app.close();
});

Deno.test("unmatched requests are events with status and code", async () => {
  const events: AppEvent[] = [];
  const app = await build({ events, documents: [{ path: "/openapi.json", content: {} }] });
  const requests: [string, string][] = [["GET", "/nowhere"], ["POST", "/open"], [
    "GET",
    "/items/%E0%A4%A",
  ]];
  for (const [method, path] of requests) {
    await (await app.fetch(new Request(`http://t${path}`, { method }))).body?.cancel();
  }
  await (await get(app, "/openapi.json")).body?.cancel();
  assertEquals(
    events.filter((event) => event.type === "request.unmatched").map((event) =>
      event.type === "request.unmatched" && [event.method, event.status, event.code]
    ),
    [["GET", 404, "NOT_FOUND"], ["POST", 405, "METHOD_NOT_ALLOWED"], [
      "GET",
      400,
      "MALFORMED_REQUEST",
    ]],
  );
  await app.close();
});

Deno.test("without a listener, routine traffic is not written to the console", async () => {
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    const app = await createApp({
      api,
      implementations: [
        implement(contract, {
          open: () => ({ status: 200, body: { who: "x" } }),
          guarded: () => ({ status: 200, body: { who: "x" } }),
          broken: () => ({ status: 200, body: { who: "x" } }),
          item: () => ({ status: 200, body: { who: "x" } }),
        }),
      ],
      verifiers: { bearer: () => null, key: () => null },
    });
    for (const path of ["/nowhere", "/guarded", "/open"]) {
      await (await get(app, path)).body?.cancel();
    }
    assertEquals(warnings, [], "404s, denials, and successes are not problems");
    await app.close();
  } finally {
    console.warn = warn;
  }
});
