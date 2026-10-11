// Every everyday response is a typed result (RFC 0001 A47–A50): streamed text, bytes, several
// header values, and parameter defaults, with no raw `Response`.
import { assertEquals } from "@std/assert";
import T from "typebox";
import { createApp, implement } from "@hyapi/core";
import { defineApi, defineContract, withDefault } from "@hyapi/core/contract";

const files = defineContract({
  operations: {
    events: {
      method: "GET",
      path: "/events",
      responses: {
        200: {
          description: "Server-sent events",
          body: T.String(),
          mediaType: "text/event-stream",
        },
      },
    },
    download: {
      method: "GET",
      path: "/files/{name}",
      params: T.Object({ name: T.String() }),
      query: T.Object({
        as: withDefault(T.Union([T.Literal("bytes"), T.Literal("blob")]), "bytes"),
      }),
      responses: {
        200: {
          description: "The file",
          body: T.String({ format: "binary" }),
          mediaType: "application/octet-stream",
        },
      },
    },
    login: {
      method: "POST",
      path: "/login",
      responses: { 204: { description: "Signed in" } },
    },
  },
});

const bytes = new TextEncoder().encode("file contents");

const implementation = implement(files, {
  events: () => ({
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
        controller.enqueue(new TextEncoder().encode("data: two\n\n"));
        controller.close();
      },
    }),
  }),
  download: ({ query }) => {
    // withDefault makes the parameter required in the input: `as` is never undefined.
    const kind: "bytes" | "blob" = query.as;
    return { status: 200, body: kind === "blob" ? new Blob([bytes]) : bytes };
  },
  login: () => ({
    status: 204,
    headers: { "set-cookie": ["session=abc; HttpOnly", "theme=dark"], "x-login": "ok" },
  }),
});

const app = await createApp({
  api: defineApi({ info: { title: "Typed responses", version: "1" }, contracts: [files] }),
  implementations: [implementation],
  responseValidation: "enforce",
});

const call = (method: string, path: string) =>
  app.fetch(new Request(`http://test${path}`, { method }));

Deno.test("a text body streams, as server-sent events do", async () => {
  const response = await call("GET", "/events");
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "text/event-stream");
  assertEquals(await response.text(), "data: one\n\ndata: two\n\n");
});

Deno.test("a byte body is bytes or a Blob, and a default fills an absent parameter", async () => {
  for (const [query, expected] of [["", "file contents"], ["?as=blob", "file contents"]]) {
    const response = await call("GET", `/files/report.txt${query}`);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "application/octet-stream");
    assertEquals(await response.text(), expected);
  }
});

Deno.test("a header with several values is sent once per value", async () => {
  const response = await call("POST", "/login");
  assertEquals(response.status, 204);
  assertEquals(response.headers.getSetCookie(), ["session=abc; HttpOnly", "theme=dark"]);
  assertEquals(response.headers.get("x-login"), "ok");
});

// Type-level checks: each @ts-expect-error must be consumed by the error it names.
implement(files, {
  // @ts-expect-error a raw Response is not a handler result
  events: () => new Response("data: x\n\n"),
  // @ts-expect-error a byte body is not a JSON value
  download: () => ({ status: 200, body: { name: "report" } }),
  login: () => ({ status: 204 }),
});
