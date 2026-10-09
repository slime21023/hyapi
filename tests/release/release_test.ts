import { assertEquals } from "@std/assert";
import { fromFileUrl } from "jsr:@std/path@^1";
import { checkRelease, publishedPackages } from "../../scripts/check_release.ts";

const root = fromFileUrl(new URL("../..", import.meta.url));

Deno.test("every published package is ready to release together", async () => {
  assertEquals(await checkRelease(root), []);
});

Deno.test("the workspace publishes the eight v1 packages", async () => {
  const names = (await publishedPackages(root)).map(({ manifest }) => manifest.name).sort();
  assertEquals(names, [
    "@hyapi/cli",
    "@hyapi/core",
    "@hyapi/openapi-diff",
    "@hyapi/plugin-cors",
    "@hyapi/plugin-csrf",
    "@hyapi/plugin-jwt",
    "@hyapi/plugin-oidc",
    "@hyapi/plugin-rate-limit",
  ]);
});

Deno.test("a mismatched tag is reported", async () => {
  const problems = await checkRelease(root, "9.9.9");
  assertEquals(problems.some((p) => p.file === "CHANGELOG.md"), true);
});
