import { assert, assertEquals, assertRejects } from "@std/assert";
import Type from "typebox";
import {
  type AppEvent,
  createApp,
  createHealth,
  type DocumentOption,
  type FetchHandler,
  implement,
  type LifecycleResource,
  StartupError,
} from "@hyapi/core";
import { defineApi, defineContract, defineSchema, HealthReport } from "@hyapi/core/contract";

const T = Type;
const Message = defineSchema("Message", T.Object({ text: T.String() }));

const contract = defineContract({
  operations: {
    hello: { method: "GET", path: "/hello", responses: { 200: Message } },
    wait: {
      method: "GET",
      path: "/wait",
      query: T.Object({ ms: T.Integer() }),
      responses: { 200: Message },
    },
    bad: { method: "GET", path: "/bad", responses: { 200: Message } },
    old: { method: "GET", path: "/old", deprecated: true, responses: { 200: Message } },
    health: {
      method: "GET",
      path: "/health",
      responses: { 200: HealthReport, 503: HealthReport },
    },
  },
});
const api = defineApi({ info: { title: "Lifecycle", version: "1" }, contracts: [contract] });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

function build(options: {
  lifecycle?: LifecycleResource[];
  events?: AppEvent[];
  onEvent?: (event: AppEvent) => void;
  shutdownTimeoutMs?: number;
  requestTimeoutMs?: number;
  timeouts?: { wait?: number };
  healthy?: () => boolean;
  documents?: DocumentOption[];
} = {}) {
  const health = createHealth({
    database: () => {
      if (options.healthy && !options.healthy()) throw new Error("database down");
    },
    cache: () => ({ status: "degraded", detail: "warming up" }),
  });
  return createApp({
    api,
    implementations: [
      implement(contract, {
        hello: () => ({ status: 200, body: { text: "hi" } }),
        wait: async ({ query }, ctx) => {
          await sleep(query.ms, ctx.signal);
          return { status: 200, body: { text: `waited ${query.ms}` } };
        },
        bad: () => ({ status: 200, body: { text: 1 } as never }),
        old: () => ({ status: 200, body: { text: "old" } }),
        health: async () => {
          const report = await health.check();
          // One branch per status: TypeScript cannot split `status: 200 | 503` across a union
          // that also allows a raw Response (RFC 0001 amendment A12).
          return report.status === "unhealthy"
            ? { status: 503, body: report }
            : { status: 200, body: report };
        },
      }),
    ],
    lifecycle: options.lifecycle ?? [],
    onEvent: options.onEvent ?? ((event) => void options.events?.push(event)),
    ...(options.shutdownTimeoutMs ? { shutdownTimeoutMs: options.shutdownTimeoutMs } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    ...(options.documents ? { documents: options.documents } : {}),
  });
}

const get = async (app: { readonly fetch: FetchHandler }, path: string) =>
  await app.fetch(new Request(`http://test${path}`));

// --- Lifecycle -----------------------------------------------------------------------------------

Deno.test("resources start in order and stop in reverse on close", async () => {
  const log: string[] = [];
  const resource = (name: string): LifecycleResource => ({
    name,
    start: () => void log.push(`start ${name}`),
    stop: () => void log.push(`stop ${name}`),
  });
  const app = await build({ lifecycle: [resource("db"), resource("cache")] });
  assertEquals(log, ["start db", "start cache"]);
  await app.close();
  assertEquals(log, ["start db", "start cache", "stop cache", "stop db"]);
  await app.close(); // idempotent
  assertEquals(log.length, 4);
});

Deno.test("a failed start rolls back the started resources and rethrows", async () => {
  const log: string[] = [];
  const events: AppEvent[] = [];
  const failure = new Error("cache unreachable");
  const error = await assertRejects(() =>
    build({
      events,
      lifecycle: [
        {
          name: "db",
          start: () => void log.push("start db"),
          stop: () => void log.push("stop db"),
        },
        { name: "cache", start: () => Promise.reject(failure) },
        { name: "never", start: () => void log.push("start never") },
      ],
    })
  );
  assertEquals(error, failure);
  assertEquals(log, ["start db", "stop db"]);
  assertEquals(events.map((e) => e.type), ["lifecycle.error"]);
});

Deno.test("rollback failures are aggregated with the original error first", async () => {
  const error = await assertRejects(
    () =>
      build({
        lifecycle: [
          { name: "db", stop: () => Promise.reject(new Error("db stuck")) },
          { name: "cache", start: () => Promise.reject(new Error("cache down")) },
        ],
      }),
    AggregateError,
  );
  assertEquals(error.errors.map((e: Error) => e.message), ["cache down", "db stuck"]);
});

Deno.test("stop failures and stop timeouts are reported by close", async () => {
  const log: string[] = [];
  const app = await build({
    shutdownTimeoutMs: 30,
    lifecycle: [
      { name: "first", stop: () => void log.push("first stopped") },
      { name: "slow", stop: (signal: AbortSignal) => sleep(10_000, signal) },
      { name: "broken", stop: () => Promise.reject(new Error("broken")) },
    ],
  });
  const error = await assertRejects(() => app.close(), AggregateError);
  assertEquals(error.errors.length, 2);
  assertEquals(log, ["first stopped"], "later resources still stop after failures");
});

Deno.test("startup rejects invalid lifecycle resources and timeout targets", async () => {
  const error = await assertRejects(
    () =>
      createApp({
        api,
        implementations: [],
        lifecycle: [{ name: "a" }, { name: "a" }, { name: "" }],
        timeouts: { nope: 10 } as never,
      }),
    StartupError,
  );
  const codes = error.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
  assertEquals(codes.filter((c) => c === "invalid-lifecycle").length, 2);
  assert(codes.includes("unknown-timeout-target"));
});

// --- Shutdown ------------------------------------------------------------------------------------

Deno.test("close drains in-flight requests, then refuses new ones", async () => {
  const app = await build();
  const inflight = get(app, "/wait?ms=50");
  await sleep(5);
  const closed = app.close();
  const refused = await get(app, "/hello");
  assertEquals(refused.status, 503);
  assertEquals((await refused.json()).code, "SHUTTING_DOWN");
  const response = await inflight;
  assertEquals([response.status, (await response.json()).text], [200, "waited 50"]);
  await closed;
});

Deno.test("close aborts requests that outlive the shutdown budget", async () => {
  const app = await build({ shutdownTimeoutMs: 20 });
  const inflight = get(app, "/wait?ms=10000");
  await sleep(5);
  await app.close();
  const response = await inflight;
  assertEquals([response.status, (await response.json()).code], [503, "SHUTTING_DOWN"]);
});

// --- Health --------------------------------------------------------------------------------------

Deno.test("health aggregates checks into one report", async () => {
  let healthy = true;
  const app = await build({ healthy: () => healthy });
  const degraded = await get(app, "/health");
  const report = await degraded.json();
  assertEquals([degraded.status, report.status], [200, "degraded"]);
  assertEquals(report.checks.cache, {
    status: "degraded",
    durationMs: report.checks.cache.durationMs,
    detail: "warming up",
  });
  healthy = false;
  const down = await get(app, "/health");
  assertEquals([down.status, (await down.json()).checks.database.detail], [503, "database down"]);
  healthy = true;
  await app.close();
});

Deno.test("a closing app answers its health operation with 503, and health has no global state", async () => {
  const health = createHealth({ ok: () => {} });
  const handlers = {
    hello: () => ({ status: 200 as const, body: { text: "hi" } }),
    wait: () => ({ status: 200 as const, body: { text: "" } }),
    bad: () => ({ status: 200 as const, body: { text: "" } }),
    old: () => ({ status: 200 as const, body: { text: "" } }),
    health: async () => ({ status: 200 as const, body: await health.check() }),
  };
  // Two applications share one aggregator; closing one must not affect the other.
  const first = await createApp({ api, implementations: [implement(contract, handlers)] });
  const second = await createApp({ api, implementations: [implement(contract, handlers)] });
  await first.close();
  const closed = await get(first, "/health");
  assertEquals([closed.status, (await closed.json()).code], [503, "SHUTTING_DOWN"]);
  const open = await get(second, "/health");
  assertEquals([open.status, (await open.json()).status], [200, "healthy"]);
  assertEquals(Object.keys(await health.check()).sort(), ["checks", "status"]);
  await second.close();
});

Deno.test("health checks time out", async () => {
  const health = createHealth({ slow: (signal: AbortSignal) => sleep(10_000, signal) }, {
    timeoutMs: 20,
  });
  const report = await health.check();
  assertEquals(report.status, "unhealthy");
  assert(report.checks.slow!.detail!.includes("timed out"));
});

// --- Events --------------------------------------------------------------------------------------

Deno.test("operations emit start and end events with status, duration, and codes", async () => {
  const events: AppEvent[] = [];
  const app = await build({ events });
  await (await get(app, "/old")).text();
  await (await get(app, "/wait?ms=x")).text();
  await (await get(app, "/nothing")).text();
  const ends = events.filter((e) => e.type === "operation.end");
  assertEquals(
    ends.map((e) => e.type === "operation.end" && [e.operationId, e.status, e.deprecated, e.code]),
    [["old", 200, true, undefined], ["wait", 400, false, "VALIDATION_FAILED"]],
  );
  assertEquals(events.filter((e) => e.type === "operation.start").length, 2, "404s emit nothing");
  assert(ends.every((e) => e.type === "operation.end" && e.durationMs >= 0));
  await app.close();
});

Deno.test("response violations are events, not console output, when a listener exists", async () => {
  const events: AppEvent[] = [];
  const app = await build({ events });
  assertEquals((await get(app, "/bad")).status, 200);
  const violation = events.find((e) => e.type === "response.violation");
  assert(violation?.type === "response.violation" && violation.violations.length > 0);
  await app.close();
});

Deno.test("listener failures never affect responses", async () => {
  const error = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const app = await build({
      onEvent: (event) => {
        if (event.type === "operation.start") throw new Error("listener broke");
        if (event.type === "operation.end") {
          return Promise.reject(new Error("async listener broke"));
        }
      },
    });
    const response = await get(app, "/hello");
    assertEquals([response.status, (await response.json()).text], [200, "hi"]);
    await sleep(5);
    assertEquals(errors.length, 2);
    await app.close();
  } finally {
    console.error = error;
  }
});

// --- Timeouts and the document endpoint ----------------------------------------------------------

Deno.test("per-operation timeouts override the request timeout", async () => {
  const app = await build({ requestTimeoutMs: 20, timeouts: { wait: 200 } });
  assertEquals((await get(app, "/wait?ms=60")).status, 200);
  const slow = await get(app, "/wait?ms=1000");
  assertEquals([slow.status, (await slow.json()).code], [503, "REQUEST_TIMEOUT"]);
  await app.close();
});

Deno.test("document endpoints serve emitted documents", async () => {
  const content = { openapi: "3.1.1", info: { title: "Lifecycle", version: "1" }, paths: {} };
  const app = await build({
    documents: [
      { path: "/openapi.json", content },
      { path: "/internal/openapi.yaml", content: "openapi: 3.1.1\n" },
      { path: "/spec", content: "{}", contentType: "application/vnd.oai.openapi+json" },
    ],
  });
  const json = await get(app, "/openapi.json");
  assertEquals(json.headers.get("content-type"), "application/json");
  assertEquals(await json.json(), content);
  const yaml = await get(app, "/internal/openapi.yaml");
  assertEquals(
    [yaml.headers.get("content-type"), await yaml.text()],
    ["application/yaml", "openapi: 3.1.1\n"],
  );
  const custom = await get(app, "/spec");
  assertEquals(custom.headers.get("content-type"), "application/vnd.oai.openapi+json");
  await custom.body?.cancel();
  const post = await app.fetch(new Request("http://test/openapi.json", { method: "POST" }));
  assertEquals(post.status, 405);
  await post.body?.cancel();
  await app.close();
});

Deno.test("document endpoints are checked at startup", async () => {
  const content = { openapi: "3.1.1" };
  const error = await assertRejects(
    () =>
      build({
        documents: [
          { path: "/hello", content },
          { path: "/a.json", content },
          { path: "/a.json", content },
          { path: "/b.yaml", content },
          { path: "relative.json", content },
        ],
      }),
    StartupError,
  );
  assertEquals(error.diagnostics.map((d) => [d.code, d.message]), [
    ["document-route-conflict", "document path '/hello' is a declared route"],
    ["invalid-option", "document path '/a.json' is listed twice"],
    ["invalid-option", "document '/b.yaml' is application/yaml, so its content must be text"],
    ["invalid-option", "every document path must start with '/'"],
  ]);
});
