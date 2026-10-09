import { assertEquals, assertRejects } from "@std/assert";
import Type from "typebox";
import { createApp, implement, StartupError } from "@hyapi/core";
import { defineApi, defineContract } from "@hyapi/core/contract";

const T = Type;
const Note = T.Object({ text: T.String() });
const notes = defineContract({
  operations: {
    small: {
      method: "POST",
      path: "/small",
      body: Note,
      responses: { 204: { description: "OK" } },
    },
    large: {
      method: "POST",
      path: "/large",
      body: Note,
      responses: { 204: { description: "OK" } },
    },
    read: { method: "GET", path: "/read", responses: { 200: Note } },
  },
});
const api = defineApi({ info: { title: "Limits", version: "1" }, contracts: [notes] });
const implementations = [
  implement(notes, {
    small: () => ({ status: 204 }),
    large: () => ({ status: 204 }),
    read: () => ({ status: 200, body: { text: "" } }),
  }),
];

const post = (path: string, size: number) =>
  new Request(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(size) }),
  });

Deno.test("a per-operation body limit overrides bodyLimitBytes for that operation", async () => {
  const app = await createApp({
    api,
    implementations,
    onEvent: () => {},
    bodyLimitBytes: 1_000,
    bodyLimits: { small: 50 },
  });
  const rejected = await app.fetch(post("/small", 100));
  assertEquals([rejected.status, (await rejected.json()).detail], [
    413,
    "The request body exceeds 50 bytes.",
  ]);
  assertEquals((await app.fetch(post("/large", 100))).status, 204);
  const tooLarge = await app.fetch(post("/large", 2_000));
  assertEquals(tooLarge.status, 413, "other operations keep the application limit");
  await tooLarge.body?.cancel();
  await app.close();
});

Deno.test("body limits must name operations with a body, with positive integers", async () => {
  const error = await assertRejects(
    () =>
      createApp({
        api,
        implementations,
        bodyLimits: { small: 0, read: 10, nope: 10 } as never,
      }),
    StartupError,
  );
  const errors = error.diagnostics.filter((d) => d.severity === "error");
  assertEquals(errors.map((d) => [d.code, d.message]), [
    ["invalid-option", "the body limit of 'small' must be a positive integer"],
    ["unknown-body-limit-target", "'read' declares no request body"],
    ["unknown-body-limit-target", "'nope' is not an operation of the API"],
  ]);
});

Deno.test("body limits are keyed by operationId in types", () => {
  const options = {
    api,
    implementations,
    // @ts-expect-error 'nope' is not an operationId of the API
    bodyLimits: { nope: 10 },
  } satisfies Parameters<typeof createApp<typeof api>>[0];
  void options;
});
