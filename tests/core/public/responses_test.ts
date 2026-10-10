import { assert, assertEquals, assertRejects } from "@std/assert";
import Type from "typebox";
import {
  type AppEvent,
  createApp,
  type FetchHandler,
  implement,
  type ResponseValidation,
} from "@hyapi/core";
import { defineApi, defineContract, defineSchema } from "@hyapi/core/contract";

const T = Type;
const Count = defineSchema("Count", T.Object({ n: T.Integer() }));

const counts = defineContract({
  operations: {
    count: {
      method: "GET",
      path: "/count",
      query: T.Object({ value: T.String() }),
      responses: {
        200: { description: "Counted", body: Count, headers: T.Object({ "x-count": T.Integer() }) },
      },
    },
    events: {
      method: "GET",
      path: "/events",
      responses: { 200: { description: "A stream", body: T.String(), mediaType: "text/plain" } },
    },
    feed: {
      method: "GET",
      path: "/feed",
      responses: { 200: { description: "A stream", body: T.String(), mediaType: "text/plain" } },
    },
  },
});
const api = defineApi({ info: { title: "Responses", version: "1" }, contracts: [counts] });

/** A stream the test feeds and ends by hand. */
function manualStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

async function build(
  options: {
    responseValidation?: ResponseValidation;
    events?: AppEvent[];
    shutdownTimeoutMs?: number;
    log?: string[];
    feed?: ReadableStream<Uint8Array>;
  } = {},
) {
  return await createApp({
    api,
    responseValidation: options.responseValidation ?? "enforce",
    onEvent: (event) => void options.events?.push(event),
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2_000,
    lifecycle: [{ name: "db", stop: () => void options.log?.push("db stopped") }],
    implementations: [
      implement(counts, {
        count: ({ query }) => ({
          status: 200,
          body: { n: 1 },
          headers: { "x-count": (query.value === "bad" ? "nope" : 3) as number },
        }),
        events: () =>
          new Response(options.feed ?? "done", { headers: { "content-type": "text/plain" } }),
        feed: () => ({ status: 200, body: (options.feed ?? "done") as unknown as string }),
      }),
    ],
  });
}

const get = async (app: { readonly fetch: FetchHandler }, path: string) =>
  await app.fetch(new Request(`http://t${path}`));

// --- Response headers and the policy ------------------------------------------------------------

Deno.test("response header values are validated against their schemas", async () => {
  const app = await build();
  const good = await get(app, "/count?value=ok");
  assertEquals([good.status, good.headers.get("x-count")], [200, "3"]);
  await good.body?.cancel();
  const bad = await get(app, "/count?value=bad");
  assertEquals([bad.status, (await bad.json()).code], [500, "RESPONSE_CONTRACT_VIOLATION"]);
  await app.close();
});

Deno.test("with responseValidation off, no check runs and no violation is reported", async () => {
  const events: AppEvent[] = [];
  const app = await build({ responseValidation: "off", events });
  const response = await get(app, "/count?value=bad");
  assertEquals([response.status, response.headers.get("x-count")], [200, "nope"]);
  await response.body?.cancel();
  assertEquals(events.filter((e) => e.type === "response.violation"), []);
  await app.close();
});

// --- Streamed bodies and shutdown ---------------------------------------------------------------

Deno.test("close waits for an open stream, and resources stop after it ends", async () => {
  const log: string[] = [];
  const feed = manualStream();
  const app = await build({ log, feed: feed.stream });
  const response = await get(app, "/events");
  const reader = response.body!.getReader();
  feed.push("first ");

  let closed = false;
  const closing = app.close().then(() => void (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(!closed, "close waits while the stream is open");
  assertEquals(log, []);
  const refused = await get(app, "/count?value=ok");
  assertEquals(refused.status, 503);
  await refused.body?.cancel();

  feed.push("second");
  feed.end();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await closing;
  assertEquals(text, "first second");
  assertEquals(log, ["db stopped"]);
});

Deno.test("a stream that outlives the shutdown budget is aborted", async () => {
  const log: string[] = [];
  const feed = manualStream();
  const app = await build({ log, feed: feed.stream, shutdownTimeoutMs: 50 });
  const response = await get(app, "/feed");
  const reader = response.body!.getReader();
  feed.push("partial");
  await reader.read();
  await app.close();
  await assertRejects(() => reader.read());
  assertEquals(log, ["db stopped"]);
});

Deno.test("a result body may be a stream", async () => {
  const feed = manualStream();
  const app = await build({ feed: feed.stream });
  const response = await get(app, "/feed");
  assertEquals(response.status, 200, "streams are not validated, so enforce does not reject them");
  feed.push("streamed");
  feed.end();
  assertEquals(await response.text(), "streamed");
  await app.close();
});
