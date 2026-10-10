// Everything in HyAPI that knows TypeBox's internals (ADR 0004 §1): its non-enumerable `~` markers,
// the formats it checks, and how to copy schemas without losing either. A TypeBox upgrade is
// audited here. Mechanisms only: no diagnostics, no policy, and no state.
import type { TSchema } from "typebox";
import { type Dict, isRecord } from "./record.ts";

/** What TypeBox marks every schema with, as a type. */
export type SchemaLike = { readonly "~kind": unknown };

/**
 * Returns true when the value is a TypeBox schema rather than a plain object. TypeBox's `TSchema`
 * is an empty interface, so the guard narrows to schemas that carry TypeBox's `~kind` marker.
 */
export function isSchema(value: unknown): value is TSchema & SchemaLike {
  return typeof value === "object" && value !== null && ("~kind" in value || "~unsafe" in value);
}

// A non-enumerable string key, like TypeBox's own `~kind` markers. TypeBox keeps such keys when
// it derives schemas (T.Omit, T.Partial, ...), so nested named schemas keep their names, while
// the derived top-level schema does not inherit one. JSON serialization ignores the key.
const NAME = "~hyapi.name";

/** Returns a copy of a schema that carries a component name; the input is never mutated. */
export function withSchemaName<Schema extends TSchema>(schema: Schema, name: string): Schema {
  const named = Object.create(
    Object.getPrototypeOf(schema),
    Object.getOwnPropertyDescriptors(schema),
  ) as Schema;
  Object.defineProperty(named, NAME, { value: name, enumerable: false });
  return named;
}

/** Returns the component name given by `defineSchema`, if any. */
export function schemaName(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const name = (schema as Record<string, unknown>)[NAME];
  return typeof name === "string" ? name : undefined;
}

/** Returns true when a schema transforms values in code (`T.Codec`), which JSON Schema cannot show. */
export function hasCodec(schema: Dict): boolean {
  return "~codec" in schema;
}

/** Returns true when a schema checks values in code (`T.Refine`), which JSON Schema cannot show. */
export function hasRefinement(schema: Dict): boolean {
  return "~refine" in schema;
}

/** The properties and required names of a `T.Object` schema, or undefined for anything else. */
export function objectSchema(
  value: unknown,
): { properties: Readonly<Record<string, TSchema>>; required: ReadonlySet<string> } | undefined {
  if (!isSchema(value)) return undefined;
  const schema = value as unknown as Dict;
  if (schema.type !== "object" || !isRecord(schema.properties)) return undefined;
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  return {
    properties: schema.properties as Readonly<Record<string, TSchema>>,
    required: new Set(required),
  };
}

/** Formats that TypeBox checks (ADR 0003 §6). */
export const STANDARD_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uri-template",
  "url",
  "uuid",
  "json-pointer",
  "json-pointer-uri-fragment",
  "relative-json-pointer",
  "regex",
]);

// OpenAPI-registered formats that are annotations rather than checks. `int32` is enforced as a
// range by the runtime.
export const ANNOTATION_FORMATS: ReadonlySet<string> = new Set([
  "int32",
  "int64",
  "float",
  "double",
  "password",
  "byte",
  "binary",
]);

// Copies that keep TypeBox's non-enumerable markers (`~kind`, `~optional`, ...), which TypeBox's
// Convert, Default, and Clean need, and HyAPI's `~hyapi.name`.
function copy(node: unknown, memo: Map<object, unknown>, freeze: boolean): unknown {
  if (typeof node !== "object" || node === null) return node;
  const seen = memo.get(node);
  if (seen !== undefined) return seen;
  if (Array.isArray(node)) {
    const array: unknown[] = [];
    memo.set(node, array);
    for (const item of node) array.push(copy(item, memo, freeze));
    return freeze ? Object.freeze(array) : array;
  }
  const descriptors = Object.getOwnPropertyDescriptors(node);
  const target = Object.create(Object.getPrototypeOf(node));
  memo.set(node, target);
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor) {
      descriptor.value = copy(descriptor.value, memo, freeze);
      // A copy of a frozen value starts writable, so `cloneSchema` results can be adjusted.
      descriptor.writable = true;
    }
    descriptor.configurable = true;
  }
  Object.defineProperties(target, descriptors);
  return freeze ? Object.freeze(target) : target;
}

/** A deep, writable copy of a schema. Shared nodes stay shared in the copy. */
export function cloneSchema(schema: TSchema): TSchema {
  return copy(schema, new Map(), false) as TSchema;
}

/**
 * A deep, frozen copy of a value, such as a contract model or a schema. Shared nodes stay shared,
 * so a schema referenced from several places is still one object in the copy. Functions are kept
 * as they are.
 *
 * @typeParam Value - The type of the value, which the copy keeps.
 */
export function snapshot<Value>(value: Value): Value {
  return copy(value, new Map(), true) as Value;
}
