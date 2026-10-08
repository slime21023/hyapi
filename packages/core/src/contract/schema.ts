import Type, { type TSchema } from "typebox";

// A non-enumerable string key, like TypeBox's own `~kind` markers. TypeBox keeps such keys when
// it derives schemas (T.Omit, T.Partial, ...), so nested named schemas keep their names, while
// the derived top-level schema does not inherit one. JSON serialization ignores the key.
const NAME = "~hyapi.name";

/**
 * Names a schema so that it is emitted as `#/components/schemas/<name>` and referenced by `$ref`.
 *
 * Returns a copy of the schema that carries the name, so the input schema is never mutated.
 *
 * @example
 * ```ts
 * export const User = defineSchema("User", T.Object({ id: T.String(), name: T.String() }));
 * ```
 */
export function defineSchema<S extends TSchema>(name: string, schema: S): S {
  const named = Object.create(
    Object.getPrototypeOf(schema),
    Object.getOwnPropertyDescriptors(schema),
  ) as S;
  Object.defineProperty(named, NAME, { value: name, enumerable: false });
  return named;
}

/** Returns the component name given by {@link defineSchema}, if any. */
export function schemaName(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const name = (schema as Record<string, unknown>)[NAME];
  return typeof name === "string" ? name : undefined;
}

/**
 * Returns true when the value is a TypeBox schema rather than a plain object. TypeBox's `TSchema`
 * is an empty interface, so the guard narrows to schemas that carry TypeBox's `~kind` marker.
 */
export function isSchema(value: unknown): value is TSchema & { readonly "~kind": unknown } {
  return typeof value === "object" && value !== null && ("~kind" in value || "~unsafe" in value);
}

/**
 * The RFC 9457 problem details schema. A response whose body is `Problem` is served as
 * `application/problem+json`.
 */
export const Problem = defineSchema(
  "Problem",
  Type.Object({
    type: Type.Optional(Type.String({ format: "uri-reference" })),
    title: Type.Optional(Type.String()),
    status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String({ format: "uri-reference" })),
  }, { additionalProperties: true }),
);
