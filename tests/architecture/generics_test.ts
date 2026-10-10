import { assertEquals } from "@std/assert";
import { checkRepositoryTypeParameters, checkTypeParameters } from "./generics.ts";
import { ROOT } from "./repository.ts";

const names = (source: string) => checkTypeParameters("x.ts", source).map((v) => v.name);

Deno.test("packages name every type parameter for what it holds", async () => {
  const violations = await checkRepositoryTypeParameters(ROOT);
  assertEquals(violations.map((v) => `${v.file}:${v.line} ${v.name}`), []);
});

Deno.test("short names are reported in declarations, infer, and mapped types", () => {
  assertEquals(names("type Box<T> = { value: T };"), ["T"]);
  assertEquals(names("type First<List> = List extends [infer H, ...unknown[]] ? H : never;"), [
    "H",
  ]);
  assertEquals(names("type Flags<Keys extends string> = { [K in Keys]: boolean };"), ["K"]);
  assertEquals(names("function identity<Value>(value: Value): Value { return value; }"), []);
});
