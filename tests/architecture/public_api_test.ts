import { assertEquals } from "@std/assert";
import { publicApi, SNAPSHOT } from "./public_api.ts";
import { ROOT } from "./repository.ts";

Deno.test("the public API matches its snapshot; run `deno task api:update` after a deliberate change", async () => {
  const committed = (await Deno.readTextFile(`${ROOT}/${SNAPSHOT}`)).replaceAll("\r\n", "\n");
  assertEquals(await publicApi(ROOT), committed);
});
