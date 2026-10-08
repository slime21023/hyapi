import { assertEquals } from "@std/assert";
import * as runtime from "@hyapi/core";
import * as contract from "@hyapi/core/contract";
import * as openapi from "@hyapi/core/openapi";
import * as deno from "@hyapi/core/deno";

Deno.test("the four public entry points of ADR 0002 resolve", () => {
  for (const entry of [runtime, contract, openapi, deno]) {
    assertEquals(typeof entry, "object");
  }
});

Deno.test("the package exports exactly the four public entry points", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../../../packages/core/deno.json", import.meta.url)),
  );
  assertEquals(Object.keys(config.exports).sort(), [".", "./contract", "./deno", "./openapi"]);
});
