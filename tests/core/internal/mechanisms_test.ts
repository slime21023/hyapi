// L2 mechanisms (ADR 0003 §3), tested without an application.
import { assert, assertEquals, assertRejects } from "@std/assert";
import Type from "typebox";
import type {
  BodyModel,
  OperationModel,
  ParameterModel,
} from "../../../packages/core/src/contract/model.ts";
import { snapshot } from "../../../packages/core/src/contract/snapshot.ts";
import { readBody } from "../../../packages/core/src/runtime/body.ts";
import { withDeadline } from "../../../packages/core/src/runtime/deadline.ts";
import { createHealth } from "../../../packages/core/src/runtime/health.ts";
import { startResources, stopResources } from "../../../packages/core/src/runtime/lifecycle.ts";
import { parseCookies, readParameters } from "../../../packages/core/src/runtime/params.ts";
import { compileRoutes } from "../../../packages/core/src/runtime/routing.ts";
import { createSecurity } from "../../../packages/core/src/runtime/security.ts";
import { createValidators } from "../../../packages/core/src/runtime/validation.ts";

const T = Type;

function operation(method: string, path: string): OperationModel {
  return { operationId: `${method} ${path}`, method, path } as unknown as OperationModel;
}

function parameter(
  name: string,
  location: ParameterModel["in"],
  schema: unknown,
  style: ParameterModel["style"],
  explode: boolean,
): ParameterModel {
  return {
    name,
    in: location,
    required: false,
    schema,
    style,
    explode,
    hasDefault: false,
  } as ParameterModel;
}

// --- routing -------------------------------------------------------------------------------------

Deno.test("routing: literal segments win, and Allow spans every matching template", () => {
  const router = compileRoutes([
    operation("GET", "/items/{id}"),
    operation("GET", "/items/mine"),
    operation("DELETE", "/items/{id}"),
    operation("GET", "/report.{format}"),
  ]);
  const mine = router.match("GET", "/items/mine");
  assert(mine.kind === "found" && mine.operation.path === "/items/mine");
  const deleted = router.match("DELETE", "/items/mine");
  assert(deleted.kind === "found" && deleted.params.id === "mine");
  const report = router.match("GET", "/report.csv");
  assert(report.kind === "found" && report.params.format === "csv");
  assertEquals(router.match("POST", "/items/1"), {
    kind: "method-not-allowed",
    allow: ["DELETE", "GET", "HEAD"],
  });
  assertEquals(router.match("GET", "/items/1/"), { kind: "not-found" });
  assertEquals(router.match("GET", "/items/%E0%A4%A"), { kind: "malformed-path" });
  const head = router.match("HEAD", "/items/1");
  assert(head.kind === "found" && head.head);
});

// --- params --------------------------------------------------------------------------------------

Deno.test("params: styles decode arrays and objects; absent parameters are left out", () => {
  const list = T.Array(T.String());
  const object = T.Object({ a: T.String(), b: T.String() });
  const url = new URL("http://t/?tags=a,b&ids=1&ids=2&filter[name]=x&a=1&b=2");
  const query = readParameters("query", [
    parameter("tags", "query", list, "form", false),
    parameter("ids", "query", list, "form", true),
    parameter("filter", "query", object, "deepObject", true),
    parameter("spread", "query", object, "form", true),
    parameter("missing", "query", T.String(), "form", true),
  ], { params: {}, url, headers: new Headers() });
  assertEquals(query, {
    tags: ["a", "b"],
    ids: ["1", "2"],
    filter: { name: "x" },
    spread: { a: "1", b: "2" },
  });
  const headers = readParameters("header", [
    parameter("x-pair", "header", object, "simple", false),
    parameter("x-kv", "header", object, "simple", true),
  ], {
    params: {},
    url,
    headers: new Headers({ "x-pair": "a,1,b,2", "x-kv": "a=1,b=2" }),
  });
  assertEquals(headers, { "x-pair": { a: "1", b: "2" }, "x-kv": { a: "1", b: "2" } });
  assertEquals([...parseCookies("a=1; b=%20x; a=2; bad")], [["a", "1"], ["b", " x"]]);
});

// --- body ----------------------------------------------------------------------------------------

const json: BodyModel = { schema: T.Object({}), mediaType: "application/json", required: true };

function post(body: BodyInit | null, type = "application/json"): Request {
  return new Request("http://t/", {
    method: "POST",
    body,
    headers: body === null ? {} : { "content-type": type },
  });
}

Deno.test("body: limits, media types, and decoding are returned as results", async () => {
  const signal = new AbortController().signal;
  assertEquals(await readBody(post('{"a":1}'), json, 100, signal), { kind: "ok", value: { a: 1 } });
  assertEquals(await readBody(post("x".repeat(10)), json, 5, signal), { kind: "too-large" });
  assertEquals((await readBody(post("{"), json, 100, signal)).kind, "malformed");
  assertEquals(await readBody(post("a", "text/plain"), json, 100, signal), {
    kind: "unsupported-media-type",
    mediaType: "text/plain",
  });
  assertEquals(await readBody(post(null), json, 100, signal), { kind: "absent" });
  assertEquals(
    await readBody(post('{"a":1}', "application/merge-patch+json"), json, 100, signal),
    { kind: "ok", value: { a: 1 } },
  );
});

Deno.test("body: aborting the signal cancels the read", async () => {
  let cancelled: unknown;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"a":'));
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  const controller = new AbortController();
  const reading = readBody(post(stream), json, 1_000, controller.signal);
  const reason = new DOMException("timed out", "TimeoutError");
  controller.abort(reason);
  await assertRejects(() => reading);
  assert(cancelled === reason, "the stream was cancelled with the abort reason");
});

// --- validation ----------------------------------------------------------------------------------

Deno.test("validation: frozen model schemas compile, and int32 implies a range", () => {
  const schema = snapshot(T.Object({
    count: T.Integer({ format: "int32" }),
    tag: T.Optional(T.String({ default: "none" })),
  }));
  const validator = createValidators()(schema);
  assertEquals(validator.check({ count: 1 }, "body"), []);
  assertEquals(validator.check({ count: 2 ** 31 }, "body")[0]?.pointer, "/count");
  assertEquals(validator.defaults({ count: 1 }), { count: 1, tag: "none" });
  assertEquals(validator.convert({ count: "7" }), { count: 7 });
  assertEquals(validator.clean({ count: 1, extra: true }, true), {
    value: { count: 1 },
    removed: ["/extra"],
  });
  assert(Object.isFrozen(schema), "validation never mutates the model");
});

// --- deadline ------------------------------------------------------------------------------------

Deno.test("deadline: work past the deadline rejects with the abort reason", async () => {
  assertEquals(await withDeadline(() => 1, 50), 1);
  let seen: AbortSignal | undefined;
  const error = await assertRejects(() =>
    withDeadline((signal) => {
      seen = signal;
      return new Promise(() => {});
    }, 5)
  );
  assert(error instanceof DOMException && error.name === "TimeoutError");
  assert(seen?.aborted);
});

// --- security ------------------------------------------------------------------------------------

Deno.test("security: denials carry status, reason, and challenges", async () => {
  const evaluate = createSecurity(
    [{ name: "bearer", spec: { type: "http", scheme: "bearer" } }],
    {
      bearer: (token: string) => token === "good" ? { identity: "user", scopes: ["read"] } : null,
    },
    "Test",
  );
  const run = (authorization: string | undefined, scopes: string[] = []) => {
    const request = new Request("http://t/", {
      headers: authorization === undefined ? {} : { authorization },
    });
    return evaluate([[{ scheme: "bearer", scopes }]], request, new URL(request.url), {
      signal: request.signal,
      request,
      operationId: "op",
    });
  };
  assertEquals(await run(undefined), {
    kind: "denied",
    denial: { status: 401, reason: "missing", challenges: ["Bearer"] },
  });
  assertEquals(await run("Bearer bad"), {
    kind: "denied",
    denial: { status: 401, reason: "invalid", challenges: ["Bearer"] },
  });
  assertEquals(await run("Bearer good", ["write"]), {
    kind: "denied",
    denial: {
      status: 403,
      reason: "insufficient-scope",
      challenges: ['Bearer error="insufficient_scope", scope="write"'],
    },
  });
  assertEquals(await run("Bearer good", ["read"]), {
    kind: "allowed",
    security: { bearer: "user" },
  });
});

// --- lifecycle and health ------------------------------------------------------------------------

Deno.test("lifecycle: failures are returned, with rollback in reverse order", async () => {
  const log: string[] = [];
  const failures = await startResources([
    { name: "a", start: () => void log.push("start a"), stop: () => void log.push("stop a") },
    { name: "b", start: () => void log.push("start b"), stop: () => Promise.reject("b broke") },
    { name: "c", start: () => Promise.reject(new Error("c failed")) },
  ], 1_000);
  assertEquals(log, ["start a", "start b", "stop a"]);
  assertEquals(failures.map((f) => [f.name, f.phase]), [["c", "start"], ["b", "stop"]]);
  assertEquals(await stopResources([{ name: "ok", stop: () => {} }], 1_000), []);
});

Deno.test("health: the report is the worst check status, with no other state", async () => {
  const report = await createHealth({
    ok: () => {},
    slow: () => ({ status: "degraded", detail: "warming" }),
  }).check();
  assertEquals(report.status, "degraded");
  assertEquals(Object.keys(report).sort(), ["checks", "status"]);
});
