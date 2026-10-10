import { assertEquals } from "@std/assert";
import { checkFile, checkRepository, componentOf, importSpecifiers } from "./imports.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

function reasons(path: string, source: string): string[] {
  return checkFile(path, source).map((violation) => violation.reason);
}

Deno.test("the repository follows the ADR 0002 dependency rules", async () => {
  assertEquals(await checkRepository(root), []);
});

Deno.test("files are classified into components", () => {
  assertEquals(componentOf("packages/core/contract.ts")?.component, "contract");
  assertEquals(componentOf("packages/core/mod.ts")?.component, "runtime");
  assertEquals(componentOf("packages/core/src/deno/serve.ts")?.component, "serve");
  assertEquals(componentOf("packages/core/src/base/http.ts")?.component, "base");
  assertEquals(componentOf("packages/plugin-jwt/mod.ts"), {
    component: "plugin",
    owner: "plugin-jwt",
  });
  assertEquals(componentOf("packages/core/src/unknown/x.ts"), undefined);
});

Deno.test("import specifiers include every import form and skip comments", () => {
  const source = `
import { a } from "./a.ts";
import type { B } from "../b.ts";
import "./side-effect.ts";
export * from "./reexport.ts";
export { c } from "./c.ts";
import {
  d,
  e,
} from "typebox";
const lazy = await import("./lazy.ts");
// import { commented } from "./commented.ts";
/* import { blocked } from "./blocked.ts"; */
export const text = "import from nowhere";
const message = "both must import " +
  "the same value";
`;
  assertEquals(importSpecifiers(source), [
    "./a.ts",
    "../b.ts",
    "./side-effect.ts",
    "./reexport.ts",
    "./c.ts",
    "typebox",
    "./lazy.ts",
  ]);
});

Deno.test("allowed edges pass", () => {
  assertEquals(reasons("packages/core/src/runtime/app.ts", `import "../contract/mod.ts";`), []);
  assertEquals(reasons("packages/core/src/runtime/app.ts", `import "typebox";`), []);
  assertEquals(reasons("packages/core/src/openapi/emit.ts", `import "../contract/model.ts";`), []);
  assertEquals(
    reasons("packages/core/src/contract/declare/api.ts", `import "npm:typebox@1/value";`),
    [],
  );
  assertEquals(reasons("packages/core/src/deno/serve.ts", `import "../../mod.ts";`), []);
  assertEquals(reasons("packages/core/src/runtime/body.ts", `import "../base/http.ts";`), []);
  assertEquals(reasons("packages/core/src/base/typebox.ts", `import "typebox";`), []);
  assertEquals(reasons("packages/cli/emit.ts", `import "@hyapi/core/contract";`), []);
  assertEquals(reasons("packages/cli/diff.ts", `import "@hyapi/openapi-diff";`), []);
  assertEquals(reasons("packages/cli/diff.ts", `import "jsr:@std/fs";`), []);
  assertEquals(reasons("packages/plugin-jwt/mod.ts", `import "@hyapi/core";`), []);
  assertEquals(reasons("packages/plugin-jwt/mod.ts", `import "./verify.ts";`), []);
});

Deno.test("forbidden edges fail", () => {
  assertEquals(reasons("packages/core/src/contract/model.ts", `import "../runtime/app.ts";`), [
    "contract may not depend on runtime",
  ]);
  assertEquals(reasons("packages/core/src/contract/model.ts", `import "../openapi/emit.ts";`), [
    "contract may not depend on openapi",
  ]);
  assertEquals(reasons("packages/core/src/runtime/app.ts", `import "../openapi/emit.ts";`), [
    "runtime may not depend on openapi",
  ]);
  assertEquals(reasons("packages/core/src/openapi/emit.ts", `import "../runtime/app.ts";`), [
    "openapi may not depend on runtime",
  ]);
  assertEquals(reasons("packages/core/src/openapi/emit.ts", `import "typebox";`), [
    'openapi may not depend on external package "typebox"',
  ]);
  assertEquals(reasons("packages/core/src/contract/model.ts", `import "jsr:@std/path";`), [
    'contract may not depend on external package "@std/path"',
  ]);
  assertEquals(reasons("packages/core/src/deno/serve.ts", `import "../runtime/app.ts";`), [
    "serve must import runtime through its public entry point",
  ]);
  assertEquals(reasons("packages/core/src/deno/serve.ts", `import "../base/http.ts";`), [
    "serve may not depend on base",
  ]);
  assertEquals(reasons("packages/core/src/base/http.ts", `import "../contract/model.ts";`), [
    "base may not depend on contract",
  ]);
  assertEquals(reasons("packages/cli/emit.ts", `import "../core/src/contract/mod.ts";`), [
    "cli must import contract through its public entry point",
  ]);
  assertEquals(reasons("packages/cli/serve.ts", `import "@hyapi/core";`), [
    "cli may not depend on runtime",
  ]);
  assertEquals(reasons("packages/openapi-diff/mod.ts", `import "@hyapi/core/contract";`), [
    "openapi-diff may not depend on contract",
  ]);
  assertEquals(reasons("packages/plugin-jwt/mod.ts", `import "@hyapi/plugin-cors";`), [
    "plugins may not depend on other plugins",
  ]);
  assertEquals(reasons("packages/plugin-jwt/mod.ts", `import "../core/src/runtime/app.ts";`), [
    "plugin must import runtime through its public entry point",
  ]);
  assertEquals(
    reasons("packages/core/src/contract/model.ts", `import type { X } from "../runtime/x.ts";`),
    [
      "contract may not depend on runtime",
    ],
  );
});
