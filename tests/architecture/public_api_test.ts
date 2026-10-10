import { assertEquals } from "@std/assert";
import { publicApi, SNAPSHOT } from "./public_api.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

Deno.test("the public API matches its snapshot; run `deno task api:update` after a deliberate change", async () => {
  const committed = (await Deno.readTextFile(`${root}/${SNAPSHOT}`)).replaceAll("\r\n", "\n");
  assertEquals(await publicApi(root), committed);
});
