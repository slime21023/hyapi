import { assert, assertEquals, assertRejects } from "@std/assert";
import Type from "typebox";
import * as Format from "typebox/format";
import { type AppEvent, createApp, implement, notImplemented, StartupError } from "@hyapi/core";
import { defineApi, defineContract, type FormatChecks } from "@hyapi/core/contract";

const T = Type;
const Ok = T.Object({ ok: T.Boolean() });

function apiWith(format: string, formats: FormatChecks) {
  const contract = defineContract({
    operations: {
      lookup: {
        method: "GET",
        path: "/lookup",
        query: T.Object({ code: T.String({ format }) }),
        responses: { 200: Ok },
      },
      later: { method: "GET", path: "/later", responses: { 200: Ok } },
    },
  });
  return {
    contract,
    api: defineApi({ info: { title: "Formats", version: "1" }, formats, contracts: [contract] }),
  };
}

Deno.test("declared formats are validated at runtime", async () => {
  const isSku = (value: string) => /^SKU-\d{4}$/.test(value);
  const { contract, api } = apiWith("sku", { sku: isSku });
  const app = await createApp({
    api,
    onEvent: () => {},
    implementations: [
      implement(contract, {
        lookup: () => ({ status: 200, body: { ok: true } }),
        later: notImplemented,
      }),
    ],
  });
  assertEquals((await app.fetch(new Request("http://t/lookup?code=SKU-1234"))).status, 200);
  const bad = await app.fetch(new Request("http://t/lookup?code=nope"));
  assertEquals([bad.status, (await bad.json()).code], [400, "VALIDATION_FAILED"]);
  await app.close();
});

Deno.test("a format registered with a different check is a startup error", async () => {
  Format.Set("taken-elsewhere", () => true);
  const { contract, api } = apiWith("taken-elsewhere", { "taken-elsewhere": () => false });
  const error = await assertRejects(
    () =>
      createApp({
        api,
        implementations: [
          implement(contract, { lookup: notImplemented, later: notImplemented }),
        ],
      }),
    StartupError,
  );
  assertEquals(
    error.diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
    ["format-conflict"],
  );
});

Deno.test("formats are registered only when startup succeeds", async () => {
  const check = () => true;
  const { contract, api } = apiWith("only-on-success", { "only-on-success": check });
  await assertRejects(() => createApp({ api, implementations: [] }), StartupError);
  assert(!Format.Has("only-on-success"));

  // Two applications may register the same check.
  const handlers = { lookup: notImplemented, later: notImplemented };
  const one = await createApp({ api, implementations: [implement(contract, handlers)] });
  const two = await createApp({ api, implementations: [implement(contract, handlers)] });
  assert(Format.Get("only-on-success") === check);
  await one.close();
  await two.close();
});

Deno.test("not-implemented operations are startup warnings in development", async () => {
  const { contract, api } = apiWith("uuid", {});
  const events: AppEvent[] = [];
  const app = await createApp({
    api,
    development: true,
    onEvent: (event) => void events.push(event),
    implementations: [
      implement(contract, { lookup: notImplemented, later: notImplemented }),
    ],
  });
  const warnings = events.filter((e) =>
    e.type === "startup.warning" && e.code === "not-implemented"
  );
  assertEquals(
    warnings.map((e) => e.type === "startup.warning" && e.operationId),
    ["lookup", "later"],
  );
  await app.close();
});
