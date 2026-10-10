import { assertEquals } from "@std/assert";
import { checkRepositoryExports, findUnusedExports } from "./exports.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

const unused = (sources: Record<string, string>) =>
  findUnusedExports(new Map(Object.entries(sources))).map((u) => `${u.file}#${u.name}`);

Deno.test("every internal export is imported or re-exported", async () => {
  const found = await checkRepositoryExports(root);
  assertEquals(found.map((u) => `${u.file}#${u.name}`), []);
});

Deno.test("an export that no module imports is reported", () => {
  assertEquals(
    unused({
      "packages/core/src/runtime/a.ts": `export function used() {}\nexport type Unused = string;`,
      "packages/core/src/runtime/b.ts": `import { used } from "./a.ts";`,
    }),
    ["packages/core/src/runtime/a.ts#Unused"],
  );
});

Deno.test("type imports, re-exports, and namespace imports count as uses", () => {
  assertEquals(
    unused({
      "packages/core/src/runtime/a.ts": `export type T = 1;\nexport const v = 1;`,
      "packages/core/src/runtime/b.ts": `export interface I {}`,
      "packages/core/src/runtime/c.ts": `export const all = 1;`,
      "packages/core/src/runtime/mod.ts":
        `export { type I } from "./b.ts";\nimport * as C from "./c.ts";`,
      "packages/core/mod.ts":
        `import { type T, v } from "./src/runtime/a.ts";\nexport const x = 1;`,
    }),
    // `x` belongs to a public entry point; `runtime/mod.ts` exports nothing of its own.
    [],
  );
});
