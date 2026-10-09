// Copies that keep TypeBox's non-enumerable markers (`~kind`, `~optional`, ...), which TypeBox's
// Convert, Default, and Clean need, and HyAPI's `~hyapi.name`.
import type { TSchema } from "typebox";

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
