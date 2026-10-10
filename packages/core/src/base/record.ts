// Reading values whose shape is not trusted yet, such as declarations and options.

/** A plain object, read without trusting its shape. */
export type Dict = Readonly<Record<string, unknown>>;

/** Returns true for a non-null object that is not an array. */
export function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
