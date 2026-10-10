import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import * as Value from "typebox/value";
import { cloneSchema } from "../base/typebox.ts";
import type { Violation } from "./problem.ts";

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
/** Upper bound on violations reported for one value, to keep error responses small. */
const MAX_VIOLATIONS = 20;

/** A prepared validator for one schema. */
export interface Validator {
  /** Returns violations, or an empty list when the value is valid. */
  check(value: unknown, location: string): Violation[];
  /** Fills in `default` values. Returns the same or a new value. */
  defaults(value: unknown): unknown;
  /** Coerces strings to the schema's types (for parameters). */
  convert(value: unknown): unknown;
  /** Returns a copy without properties the schema does not declare, and the removed pointers. */
  clean(value: unknown, track: boolean): { value: unknown; removed: string[] };
}

/**
 * Derives the schema used for validation. The emitted document keeps the declared schema; the
 * validation copy adds the range that OpenAPI's `int32` format implies.
 */
function validationSchema(schema: TSchema): TSchema {
  const copy = cloneSchema(schema);
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) return node.forEach(visit);
    const record = node as Record<string, unknown>;
    if (record.type === "integer" && record.format === "int32") {
      record.minimum = Math.max(
        typeof record.minimum === "number" ? record.minimum : INT32_MIN,
        INT32_MIN,
      );
      record.maximum = Math.min(
        typeof record.maximum === "number" ? record.maximum : INT32_MAX,
        INT32_MAX,
      );
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(copy);
  return copy;
}

function removedPointers(before: unknown, after: unknown, pointer = ""): string[] {
  if (
    typeof before !== "object" || before === null || typeof after !== "object" || after === null
  ) {
    return [];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.flatMap((item, i) => removedPointers(item, after[i], `${pointer}/${i}`));
  }
  const removed: string[] = [];
  for (const [key, value] of Object.entries(before)) {
    const next = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (!(key in after)) removed.push(next);
    else removed.push(...removedPointers(value, (after as Record<string, unknown>)[key], next));
  }
  return removed;
}

type Compiled = ReturnType<typeof Compile>;

/** At most {@link MAX_VIOLATIONS} violations of a value, or none when it is valid. */
function violationsOf(compiled: Compiled, value: unknown, location: string): Violation[] {
  if (compiled.Check(value)) return [];
  const violations: Violation[] = [];
  for (const error of compiled.Errors(value)) {
    violations.push({ location, pointer: error.instancePath, message: error.message });
    if (violations.length === MAX_VIOLATIONS) break;
  }
  return violations;
}

function createValidator(compiled: Compiled): Validator {
  return {
    check: (value, location) => violationsOf(compiled, value, location),
    defaults: (value) => compiled.Default(value),
    convert: (value) => compiled.Convert(value),
    clean(value, track) {
      const cleaned = compiled.Clean(Value.Clone(value));
      return { value: cleaned, removed: track ? removedPointers(value, cleaned) : [] };
    },
  };
}

/** Prepares validators once per schema object and reuses them. */
export function createValidators() {
  const cache = new WeakMap<object, Validator>();
  return (schema: TSchema): Validator => {
    const cached = cache.get(schema);
    if (cached !== undefined) return cached;
    const validator = createValidator(Compile(validationSchema(schema)));
    cache.set(schema, validator);
    return validator;
  };
}

export type ValidatorFactory = ReturnType<typeof createValidators>;
