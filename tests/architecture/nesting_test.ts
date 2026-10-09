import { assertEquals } from "@std/assert";
import { checkNesting, checkRepositoryNesting, PENDING } from "./nesting.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

function chains(source: string): string[] {
  return checkNesting("x.ts", source).map((violation) => violation.chain);
}

Deno.test("packages nest at most two levels, except files still pending refactoring", async () => {
  const violations = await checkRepositoryNesting(root);
  assertEquals(
    violations.filter((v) => !PENDING.has(v.file)).map((v) => `${v.file}:${v.line} ${v.chain}`),
    [],
  );
  const stillNeeded = new Set(violations.map((v) => v.file));
  assertEquals(
    [...PENDING].filter((file) => !stillNeeded.has(file)),
    [],
    "remove refactored files from PENDING",
  );
});

Deno.test("control blocks and closures each add a level", () => {
  assertEquals(chains("function f() { for (;;) { if (a) { b(); } } }"), []);
  assertEquals(chains("function f() { for (;;) { if (a) { if (b) c(); } } }"), [
    "loop > if > if",
  ]);
  assertEquals(chains("function f() { return () => { try { if (a) b(); } catch {} }; }"), [
    "closure > try > if",
  ]);
});

Deno.test("top-level functions, else-if chains, and expression callbacks add no level", () => {
  assertEquals(chains("const f = () => { for (;;) { if (a) b(); } };"), []);
  assertEquals(chains("class C { m() { for (;;) { if (a) b(); } } }"), []);
  assertEquals(
    chains("function f() { for (;;) { if (a) x(); else if (b) y(); else if (c) z(); } }"),
    [],
  );
  assertEquals(chains("function f() { for (;;) { if (a) xs.map((x) => x.y); } }"), []);
  assertEquals(chains("function f() { for (;;) { if (a) p.catch(() => {}); } }"), []);
  assertEquals(chains("function f() { for (;;) { if (a) xs.map((x) => { return x; }); } }"), [
    "loop > if > closure",
  ]);
});
