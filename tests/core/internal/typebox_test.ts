// Pins the TypeBox behavior that Core relies on (Review 0001 A15). A TypeBox upgrade that changes
// any of it must fail here first.
import { assert, assertEquals, assertFalse } from "@std/assert";
import Type from "typebox";
import { Compile } from "typebox/compile";
import * as Format from "typebox/format";
import { cloneSchema, schemaName, snapshot } from "../../../packages/core/src/base/typebox.ts";
import { defineSchema } from "../../../packages/core/src/contract/declare/schema.ts";

const T = Type;

Deno.test("schemas carry non-enumerable '~kind' and '~optional' markers", () => {
  const schema = T.Object({ a: T.Optional(T.String()) });
  assertEquals((schema as unknown as Record<string, unknown>)["~kind"], "Object");
  assertFalse(Object.keys(schema).includes("~kind"));
  const property = schema.properties.a as unknown as Record<string, unknown>;
  assertEquals(property["~optional"], true);
  assertFalse(JSON.stringify(schema).includes("~"));
});

Deno.test("codecs and refinements are marked with '~codec' and '~refine'", () => {
  const codec = T.Codec(T.String()).Decode((value) => value).Encode((value) => value);
  assert("~codec" in codec);
  const refined = T.Refine(T.String(), (value) => value.length > 0);
  assert("~refine" in refined);
});

Deno.test("derived schemas keep the names of nested schemas, not their own", () => {
  const Author = defineSchema("Author", T.Object({ name: T.String() }));
  const Book = defineSchema("Book", T.Object({ id: T.String(), author: Author }));
  const Create = T.Omit(Book, ["id"]);
  assertEquals(schemaName(Create), undefined);
  assertEquals(schemaName(Create.properties.author), "Author");
});

Deno.test("Convert, Default, and Clean work on copies that keep the markers", () => {
  const frozen = snapshot(T.Object({ n: T.Integer(), d: T.Optional(T.String({ default: "x" })) }));
  const compiled = Compile(cloneSchema(frozen));
  assertEquals(compiled.Convert({ n: "3" }), { n: 3 });
  assertEquals(compiled.Default({ n: 1 }), { n: 1, d: "x" });
  assertEquals(compiled.Clean({ n: 1, extra: 2 }), { n: 1 });
  assert(T.Optional(cloneSchema(frozen.properties.n)));
});

Deno.test("formats are resolved when a validator is compiled", () => {
  // createApp must register declared formats before it compiles validators: a format unknown at
  // compile time is never checked, even if it is registered later.
  assert(Format.Has("email"));
  const early = Compile(T.String({ format: "pinned-late" }));
  Format.Set("pinned-late", (value) => value === "ok");
  assert(early.Check("no"), "compiled before registration: unchecked");
  const late = Compile(T.String({ format: "pinned-late" }));
  assert(late.Check("ok"));
  assertFalse(late.Check("no"));
  assert(Format.Get("pinned-late") !== undefined);
});
