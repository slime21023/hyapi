import { assert, assertEquals, assertRejects } from "@std/assert";
import Type from "typebox";
import {
  type App,
  createApp,
  implement,
  StartupError,
  type Verifier,
  type VerifierContext,
} from "@hyapi/core";
import {
  apiKey,
  type BasicCredential,
  defineApi,
  defineContract,
  defineSecurity,
  httpBasic,
  httpBearer,
  oauth2,
  openIdConnect,
} from "@hyapi/core/contract";

const T = Type;

const security = defineSecurity({
  bearer: httpBearer<{ subject: string }>(),
  basic: httpBasic<{ user: string }>(),
  headerKey: apiKey<{ client: string }>({ in: "header", name: "x-api-key" }),
  queryKey: apiKey<{ client: string }>({ in: "query", name: "key" }),
  cookieKey: apiKey<{ client: string }>({ in: "cookie", name: "session" }),
  oauth: oauth2<{ subject: string }>({
    flows: {
      clientCredentials: {
        tokenUrl: "https://auth.example.com/token",
        scopes: { "items:read": "Read", "items:write": "Write" },
      },
    },
  }),
  oidc: openIdConnect<{ subject: string }>({
    url: "https://id.example.com/.well-known/openid-configuration",
  }),
});

const Echo = T.Object({ who: T.String() });
const op = <const P extends string, const E extends object = Record<never, never>>(
  path: P,
  extra?: E,
) => ({ method: "GET" as const, path, responses: { 200: Echo }, ...(extra as E) });

const contract = defineContract({
  securitySchemes: security,
  security: [{ bearer: [] }],
  operations: {
    inherited: op("/inherited"),
    public: op("/public", { security: [] }),
    bearerRead: op("/bearer-read", { security: [{ bearer: ["items:read"] }] }),
    basic: op("/basic", { security: [{ basic: [] }] }),
    headerKey: op("/header-key", { security: [{ headerKey: [] }] }),
    queryKey: op("/query-key", { security: [{ queryKey: [] }] }),
    cookieKey: op("/cookie-key", { security: [{ cookieKey: [] }] }),
    oauth: op("/oauth", { security: [{ oauth: ["items:write"] }] }),
    oidc: op("/oidc", { security: [{ oidc: [] }] }),
    either: op("/either", { security: [{ bearer: [] }, { headerKey: [] }] }),
    both: op("/both", { security: [{ headerKey: [], bearer: [] }] }),
    validated: op("/validated/{id}", {
      security: [{ bearer: [] }],
      params: T.Object({ id: T.Integer() }),
    }),
  },
});

const api = defineApi({
  info: { title: "Secure API", version: "1.0.0" },
  securitySchemes: security,
  contracts: [contract],
});

const who = (identities: unknown) => JSON.stringify(identities);
const implementation = implement(contract, {
  inherited: (_, ctx) => ({ status: 200, body: { who: ctx.security.bearer.subject } }),
  public: (_, ctx) => ({ status: 200, body: { who: String(ctx.security) } }),
  bearerRead: (_, ctx) => ({ status: 200, body: { who: ctx.security.bearer.subject } }),
  basic: (_, ctx) => ({ status: 200, body: { who: ctx.security.basic.user } }),
  headerKey: (_, ctx) => ({ status: 200, body: { who: ctx.security.headerKey.client } }),
  queryKey: (_, ctx) => ({ status: 200, body: { who: ctx.security.queryKey.client } }),
  cookieKey: (_, ctx) => ({ status: 200, body: { who: ctx.security.cookieKey.client } }),
  oauth: (_, ctx) => ({ status: 200, body: { who: ctx.security.oauth.subject } }),
  oidc: (_, ctx) => ({ status: 200, body: { who: ctx.security.oidc.subject } }),
  either: (_, ctx) => ({ status: 200, body: { who: who(ctx.security) } }),
  both: (_, ctx) => ({
    status: 200,
    body: { who: `${ctx.security.bearer.subject}+${ctx.security.headerKey.client}` },
  }),
  validated: ({ params }) => ({ status: 200, body: { who: String(params.id) } }),
});

/** Tokens: "admin" grants items:read, "reader" grants nothing, anything else is invalid. */
function makeVerifiers(calls: string[] = []) {
  const bearer: Verifier<typeof security, "bearer"> = (token, ctx: VerifierContext) => {
    calls.push(`bearer:${token}:${ctx.operationId}`);
    if (token === "admin") return { identity: { subject: "admin" }, scopes: ["items:read"] };
    if (token === "reader") return { identity: { subject: "reader" } };
    if (token === "explode") throw new Error("key server unreachable");
    return null;
  };
  const basic: Verifier<typeof security, "basic"> = (credential: BasicCredential) =>
    credential.username === "ada" && credential.password === "p:ss"
      ? { identity: { user: credential.username } }
      : null;
  const key = (value: string) => {
    calls.push(`key:${value}`);
    return value === "k1" ? { identity: { client: "c1" } } : null;
  };
  return {
    bearer,
    basic,
    headerKey: key,
    queryKey: key,
    cookieKey: key,
    oauth: (token: string) =>
      token === "writer" ? { identity: { subject: "svc" }, scopes: ["items:write"] } : null,
    oidc: (token: string) => (token === "id" ? { identity: { subject: "person" } } : null),
  };
}

async function appWith(calls?: string[]): Promise<App> {
  return await createApp({
    api,
    implementations: [implementation],
    verifiers: makeVerifiers(calls),
  });
}

async function call(app: App, path: string, headers: Record<string, string> = {}) {
  const response = await app.fetch(new Request(`http://test${path}`, { headers }));
  return {
    status: response.status,
    challenge: response.headers.get("www-authenticate"),
    body: await response.json(),
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

Deno.test("public operations need no credentials, and ctx.security is undefined", async () => {
  const app = await appWith();
  assertEquals((await call(app, "/public")).body, { who: "undefined" });
});

Deno.test("operations inherit the contract's default requirement", async () => {
  const app = await appWith();
  assertEquals((await call(app, "/inherited", bearer("reader"))).body, { who: "reader" });
  assertEquals((await call(app, "/inherited")).status, 401);
});

Deno.test("401 for missing, invalid, or malformed credentials, with a challenge", async () => {
  const app = await appWith();
  for (
    const headers of [{}, bearer("nope"), { authorization: "Bearer" }, { authorization: "Token x" }]
  ) {
    const response = await call(app, "/inherited", headers);
    assertEquals(response.status, 401, JSON.stringify(headers));
    assertEquals(response.body.code, "UNAUTHORIZED");
    assertEquals(response.challenge, "Bearer");
  }
});

Deno.test("403 when credentials verify but lack the required scopes", async () => {
  const app = await appWith();
  assertEquals((await call(app, "/bearer-read", bearer("admin"))).status, 200);
  const denied = await call(app, "/bearer-read", bearer("reader"));
  assertEquals(denied.status, 403);
  assertEquals(denied.body.code, "FORBIDDEN");
  assertEquals(denied.challenge, 'Bearer error="insufficient_scope", scope="items:read"');
});

Deno.test("HTTP basic credentials are decoded for the verifier", async () => {
  const app = await appWith();
  const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  assertEquals((await call(app, "/basic", { authorization: `Basic ${encode("ada:p:ss")}` })).body, {
    who: "ada",
  });
  const wrong = await call(app, "/basic", { authorization: `Basic ${encode("ada:nope")}` });
  assertEquals([wrong.status, wrong.challenge], [401, 'Basic realm="Secure API", charset="UTF-8"']);
  assertEquals((await call(app, "/basic", { authorization: "Basic !!!" })).status, 401);
  assertEquals(
    (await call(app, "/basic", { authorization: `Basic ${encode("no-colon")}` })).status,
    401,
  );
});

Deno.test("API keys are read from their declared header, query, or cookie", async () => {
  const app = await appWith();
  assertEquals((await call(app, "/header-key", { "x-api-key": "k1" })).body, { who: "c1" });
  assertEquals((await call(app, "/query-key?key=k1")).body, { who: "c1" });
  assertEquals((await call(app, "/cookie-key", { cookie: "a=1; session=k1" })).body, { who: "c1" });
  const missing = await call(app, "/header-key", { cookie: "session=k1" });
  assertEquals([missing.status, missing.challenge], [401, null]);
});

Deno.test("OAuth 2 and OpenID Connect use bearer tokens", async () => {
  const app = await appWith();
  assertEquals((await call(app, "/oauth", bearer("writer"))).body, { who: "svc" });
  assertEquals((await call(app, "/oauth", bearer("admin"))).status, 401);
  assertEquals((await call(app, "/oidc", bearer("id"))).body, { who: "person" });
});

Deno.test("alternatives are OR: the first satisfied requirement wins", async () => {
  const app = await appWith();
  assertEquals((await call(app, "/either", bearer("reader"))).body, {
    who: JSON.stringify({ bearer: { subject: "reader" } }),
  });
  assertEquals((await call(app, "/either", { "x-api-key": "k1" })).body, {
    who: JSON.stringify({ headerKey: { client: "c1" } }),
  });
  const neither = await call(app, "/either");
  assertEquals([neither.status, neither.challenge], [401, "Bearer"]);
});

Deno.test("schemes within a requirement are AND, in order, stopping at the first failure", async () => {
  const calls: string[] = [];
  const app = await appWith(calls);
  assertEquals((await call(app, "/both", { ...bearer("reader"), "x-api-key": "k1" })).body, {
    who: "reader+c1",
  });
  calls.length = 0;
  assertEquals((await call(app, "/both", { ...bearer("reader"), "x-api-key": "bad" })).status, 401);
  assertEquals(calls, ["key:bad"], "the bearer verifier is not called after the key fails");
});

Deno.test("each scheme is verified at most once per request", async () => {
  const calls: string[] = [];
  const app = await appWith(calls);
  // Both alternatives of /either fail, but bearer is shared with the /both requirement elsewhere.
  await call(app, "/either", bearer("nope"));
  assertEquals(calls.filter((c) => c.startsWith("bearer")), ["bearer:nope:either"]);
});

Deno.test("security runs before input validation", async () => {
  const app = await appWith();
  assertEquals((await call(app, "/validated/not-a-number")).status, 401);
  assertEquals((await call(app, "/validated/not-a-number", bearer("reader"))).status, 400);
});

Deno.test("a verifier that throws is an internal error", async () => {
  const app = await appWith();
  const response = await call(app, "/inherited", bearer("explode"));
  assertEquals([response.status, response.body.code], [500, "INTERNAL_ERROR"]);
});

Deno.test("verifiers are bounded by the request timeout", async () => {
  const app = await createApp({
    api,
    implementations: [implementation],
    requestTimeoutMs: 20,
    verifiers: {
      ...makeVerifiers(),
      bearer: (_token, ctx) =>
        new Promise((_resolve, reject) =>
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))
        ),
    },
  });
  const response = await call(app, "/inherited", bearer("admin"));
  assertEquals([response.status, response.body.code], [503, "REQUEST_TIMEOUT"]);
});

Deno.test("a client disconnect after the response does not leave an unhandled rejection", async () => {
  const app = await appWith();
  const controller = new AbortController();
  const response = await app.fetch(
    new Request("http://test/public", { signal: controller.signal }),
  );
  await response.body?.cancel();
  controller.abort();
  // An unhandled rejection would fail this test through Deno's sanitizer.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

Deno.test("startup requires exactly one verifier function per scheme", async () => {
  const { bearer: _omitted, ...rest } = makeVerifiers();
  const error = await assertRejects(
    () =>
      createApp({
        api,
        implementations: [implementation],
        verifiers: { ...rest, basic: "nope", stray: () => null } as never,
      }),
    StartupError,
  );
  assertEquals(
    error.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).sort(),
    ["invalid-verifier", "missing-verifier", "unknown-verifier"],
  );
});

Deno.test("verifier types follow the scheme's credential and identity", () => {
  // @ts-expect-error a basic verifier receives { username, password }, not a string
  const wrongCredential: Verifier<typeof security, "basic"> = (credential: string) => ({
    identity: { user: credential },
  });
  // @ts-expect-error the bearer identity must have a subject
  const wrongIdentity: Verifier<typeof security, "bearer"> = () => ({ identity: { name: "x" } });
  void wrongCredential;
  void wrongIdentity;
  assert(true);
});

Deno.test("createApp requires verifiers when the API declares schemes", () => {
  // @ts-expect-error verifiers are required
  void (() => createApp({ api, implementations: [implementation] }));
  assert(true);
});
