import { assertEquals } from "@std/assert";
import { checkCoreLayers, checkLayers, layerOf } from "./layers.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

function reasons(module: string, source: string): string[] {
  return checkLayers(`packages/core/src/${module}`, source).map((violation) => violation.reason);
}

Deno.test("Core follows the layer rules of ADR 0003", async () => {
  assertEquals(await checkCoreLayers(root), []);
});

Deno.test("modules are assigned to layers", () => {
  assertEquals(layerOf("packages/core/src/contract/check.ts"), 1);
  assertEquals(layerOf("packages/core/src/openapi/emit.ts"), 2);
  assertEquals(layerOf("packages/core/src/runtime/routing.ts"), 2);
  assertEquals(layerOf("packages/core/src/runtime/pipeline.ts"), 3);
  assertEquals(layerOf("packages/core/src/runtime/app.ts"), 4);
  assertEquals(layerOf("packages/core/src/deno/serve.ts"), 5);
  assertEquals(layerOf("packages/core/src/runtime/unknown.ts"), undefined);
});

Deno.test("imports may go down or sideways, never up", () => {
  assertEquals(reasons("runtime/pipeline.ts", `import "./routing.ts";`), []);
  assertEquals(reasons("runtime/routing.ts", `import "../contract/model.ts";`), []);
  assertEquals(reasons("runtime/security.ts", `import "./params.ts";`), []);
  assertEquals(reasons("runtime/security.ts", `import "./events.ts";`), [
    "L2 runtime/security.ts may not import L4 runtime/events.ts",
  ]);
  assertEquals(reasons("runtime/pipeline.ts", `import type { Emit } from "./events.ts";`), [
    "L3 runtime/pipeline.ts may not import L4 runtime/events.ts",
  ]);
  assertEquals(reasons("contract/check.ts", `import "../runtime/validation.ts";`), [
    "L1 contract/check.ts may not import L2 runtime/validation.ts",
  ]);
  assertEquals(reasons("runtime/stray.ts", ""), [
    "runtime/stray.ts has no layer; add it to ADR 0003 §3",
  ]);
});

Deno.test("modules keep no mutable state at module scope", () => {
  assertEquals(reasons("runtime/routing.ts", "const LIMIT = 20;\nfunction f() { let x = 1; }"), []);
  assertEquals(
    reasons("contract/check.ts", "const METHODS: ReadonlySet<string> = new Set(['GET']);"),
    [],
  );
  assertEquals(reasons("runtime/health.ts", "let count = 0;"), [
    "module-level mutable binding 'count'",
  ]);
  assertEquals(reasons("runtime/health.ts", "const draining = new WeakSet<Health>();"), [
    "module-level WeakSet 'draining'; keep it in a closure owned by the application",
  ]);
  assertEquals(reasons("contract/check.ts", "export const NAMES = new Set(['a']);"), [
    "module-level Set 'NAMES'; type it as ReadonlySet or keep it in a closure",
  ]);
});

Deno.test("only the application writes TypeBox's format registry", () => {
  assertEquals(reasons("runtime/app.ts", "Format.Set(name, check);"), []);
  assertEquals(reasons("contract/check.ts", "Format.Set(name, check);"), [
    "only runtime/app.ts may write TypeBox's format registry",
  ]);
});
