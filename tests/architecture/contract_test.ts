import { assertEquals } from "@std/assert";
import { checkContractBoundaries, checkRepositoryContractBoundaries } from "./contract.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

const reasons = (path: string, source: string) =>
  checkContractBoundaries(path, source).map((v) => v.reason);

Deno.test("Core follows the contract boundaries of ADR 0004", async () => {
  const violations = await checkRepositoryContractBoundaries(root);
  assertEquals(violations.map((v) => `${v.file} -> ${v.target}: ${v.reason}`), []);
});

Deno.test("the runtime and the emitter reach the compiler only through its entry points", () => {
  const runtime = "packages/core/src/runtime/app.ts";
  assertEquals(
    reasons(runtime, `import { compileContracts } from "../contract/compile/compile.ts";`),
    [],
  );
  assertEquals(reasons(runtime, `import type { ContractModel } from "../contract/model.ts";`), []);
  assertEquals(reasons(runtime, `import { Problem } from "../contract/declare/schema.ts";`), []);
  assertEquals(reasons(runtime, `import type { Api } from "../contract/declare/api.ts";`), []);
  assertEquals(
    reasons(runtime, `import { type Schemes } from "../contract/declare/security.ts";`),
    [],
  );
  assertEquals(reasons(runtime, `import { defineApi } from "../contract/declare/api.ts";`), [
    "contract/declare/api.ts may only be imported for types",
  ]);
  assertEquals(
    reasons(
      "packages/core/src/openapi/emit.ts",
      `import { x } from "../contract/compile/body.ts";`,
    ),
    [
      "contract/compile/body.ts is private to the contract compiler; use model.ts, " +
      "compile/compile.ts, compile/diagnostics.ts, or the declaration types",
    ],
  );
});

Deno.test("dependencies inside the contract component point one way", () => {
  assertEquals(
    reasons("packages/core/src/contract/declare/api.ts", `import "../compile/compile.ts";`),
    ["contract/declare/api.ts may not import contract/compile/compile.ts"],
  );
  assertEquals(
    reasons("packages/core/src/contract/model.ts", `import type { Api } from "./declare/api.ts";`),
    ["contract/model.ts may not import contract/declare/api.ts"],
  );
  assertEquals(
    reasons(
      "packages/core/src/contract/compile/api.ts",
      `import type { Api } from "../declare/api.ts";`,
    ),
    [],
  );
});
