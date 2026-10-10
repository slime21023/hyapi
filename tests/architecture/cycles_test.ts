import { assertEquals } from "@std/assert";
import { checkRepositoryCycles, findCycles, importGraph } from "./cycles.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

Deno.test("the import graph of packages/ has no cycles", async () => {
  const cycles = await checkRepositoryCycles(root);
  assertEquals(cycles.map((cycle) => cycle.join(" -> ")), []);
});

Deno.test("a diamond is acyclic, and a loop back to a module on the path is a cycle", () => {
  const diamond = new Map([["a", ["b", "c"]], ["b", ["d"]], ["c", ["d"]], ["d", []]]);
  assertEquals(findCycles(diamond), []);
  const loop = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]);
  assertEquals(findCycles(loop), [["a", "b", "c", "a"]]);
});

Deno.test("type-only imports, re-exports, and package entry points are edges", () => {
  const graph = importGraph(
    new Map([
      ["packages/core/src/contract/compile/operation.ts", `import { a } from "./body.ts";`],
      [
        "packages/core/src/contract/compile/body.ts",
        `import type { OperationContext } from "./operation.ts";`,
      ],
      ["packages/core/mod.ts", `export * from "./src/runtime/mod.ts";`],
      ["packages/core/src/runtime/mod.ts", ""],
      ["packages/plugin-cors/mod.ts", `import { problemResponse } from "@hyapi/core";`],
    ]),
  );
  assertEquals(graph.get("packages/core/mod.ts"), ["packages/core/src/runtime/mod.ts"]);
  assertEquals(graph.get("packages/plugin-cors/mod.ts"), ["packages/core/mod.ts"]);
  assertEquals(findCycles(graph).map((cycle) => cycle.join(" -> ")), [
    "packages/core/src/contract/compile/body.ts -> packages/core/src/contract/compile/operation.ts" +
    " -> packages/core/src/contract/compile/body.ts",
  ]);
});
