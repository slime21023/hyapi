// Comparing schemas: enums, types, constraints, properties, and items, classified by whether the
// schema describes what consumers send or what they receive.
import { type Add, breakingIf, type Direction } from "./change.ts";
import { type Deref, isObject, type Json, same } from "./document.ts";

const UPPER_BOUNDS = ["maxLength", "maxItems", "maximum", "exclusiveMaximum", "maxProperties"];
const LOWER_BOUNDS = ["minLength", "minItems", "minimum", "exclusiveMinimum", "minProperties"];
const EXACT_CONSTRAINTS = ["pattern", "format", "multipleOf", "uniqueItems"];

function enumValues(schema: Json): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  if ("const" in schema && schema.anyOf === undefined) return [schema.const];
  const members = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
    ? schema.oneOf
    : undefined;
  if (
    members !== undefined && members.length > 0 && members.every((m) => isObject(m) && "const" in m)
  ) {
    return members.map((m) => (m as Json).const);
  }
  return undefined;
}

function typeSet(schema: Json): Set<string> | undefined {
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type.map(String));
  return undefined;
}

/** True when every value of type set `a` is also allowed by `b` (integer ⊂ number). */
function within(a: Set<string>, b: Set<string>): boolean {
  return [...a].every((type) => b.has(type) || (type === "integer" && b.has("number")));
}

const composite = (schema: Json) =>
  ["anyOf", "oneOf", "allOf", "not", "if"].some((key) => key in schema);

/** The constraints a schema change tightened and loosened. */
function constraintChanges(b: Json, h: Json): { tightened: string[]; loosened: string[] } {
  const tightened: string[] = [];
  const loosened: string[] = [];
  for (const key of UPPER_BOUNDS) {
    const [bv, hv] = [b[key], h[key]];
    if (bv === hv) continue;
    if (typeof hv === "number" && (typeof bv !== "number" || hv < bv)) tightened.push(key);
    else loosened.push(key);
  }
  for (const key of LOWER_BOUNDS) {
    const [bv, hv] = [b[key], h[key]];
    if (bv === hv) continue;
    if (typeof hv === "number" && (typeof bv !== "number" || hv > bv)) tightened.push(key);
    else loosened.push(key);
  }
  for (const key of EXACT_CONSTRAINTS) {
    if (same(b[key], h[key])) continue;
    if (h[key] === undefined || h[key] === false) loosened.push(key);
    else tightened.push(key);
  }
  return { tightened, loosened };
}

/** Where a nested property or item is reported: `· name` after a media type, else `.name`. */
function child(location: string, name: string): string {
  return location.endsWith("·") ? `${location} ${name}` : `${location}.${name}`;
}

/** What a schema comparison reads and reports to. */
export interface SchemaComparison {
  /** Follows `$ref`s in the base document. */
  readonly base: Deref;
  /** Follows `$ref`s in the head document. */
  readonly head: Deref;
  readonly add: Add;
}

/** Compares two schemas in one direction, recursing into properties and items. */
export function compareSchema(
  ctx: SchemaComparison,
  rawBase: unknown,
  rawHead: unknown,
  direction: Direction,
  location: string,
  seen: Set<string>,
): void {
  const b = ctx.base(rawBase);
  const h = ctx.head(rawHead);
  if (!isObject(b) || !isObject(h)) return;
  // Identical text is unchanged only without references: the same `$ref` can point to
  // definitions that differ between the two documents.
  const text = JSON.stringify(b);
  if (text === JSON.stringify(h) && !text.includes('"$ref"')) return;
  const pair = `${JSON.stringify(rawBase)}|${JSON.stringify(rawHead)}|${direction}`;
  if (seen.has(pair)) return;
  seen.add(pair);
  const request = direction === "request";

  if (compareEnums(ctx, b, h, request, location)) return;
  if (composite(b) || composite(h)) {
    ctx.add(
      "schema-changed",
      "breaking",
      location,
      "a composite schema changed and cannot be classified; review it",
    );
    return;
  }
  if (!compareTypes(ctx, b, h, request, location)) return;
  compareConstraints(ctx, b, h, request, location);
  compareProperties(ctx, b, h, direction, location, seen);
  if (request && b.additionalProperties !== false && h.additionalProperties === false) {
    ctx.add(
      "additional-properties-restricted",
      "breaking",
      location,
      "additional properties are no longer allowed",
    );
  }
  if (b.items !== undefined || h.items !== undefined) {
    const items = location.endsWith("·") ? `${location} []` : `${location}[]`;
    compareSchema(ctx, b.items, h.items, direction, items, seen);
  }
}

/** Compares enums; true when both schemas are enums, which ends the comparison. */
function compareEnums(
  ctx: SchemaComparison,
  b: Json,
  h: Json,
  request: boolean,
  location: string,
): boolean {
  const baseEnum = enumValues(b);
  const headEnum = enumValues(h);
  if (baseEnum === undefined || headEnum === undefined) return false;
  for (const value of baseEnum.filter((v) => !headEnum.some((w) => same(v, w)))) {
    ctx.add(
      "enum-value-removed",
      breakingIf(request),
      location,
      `enum value ${JSON.stringify(value)} was removed`,
    );
  }
  for (const value of headEnum.filter((v) => !baseEnum.some((w) => same(v, w)))) {
    ctx.add(
      "enum-value-added",
      breakingIf(!request),
      location,
      `enum value ${JSON.stringify(value)} was added`,
    );
  }
  return true;
}

/** Compares types; false when they are unrelated, which ends the comparison. */
function compareTypes(
  ctx: SchemaComparison,
  b: Json,
  h: Json,
  request: boolean,
  location: string,
): boolean {
  const baseTypes = typeSet(b);
  const headTypes = typeSet(h);
  if (!baseTypes || !headTypes || same([...baseTypes].sort(), [...headTypes].sort())) {
    return true;
  }
  const widened = within(baseTypes, headTypes);
  const narrowed = within(headTypes, baseTypes);
  const describe = `type ${[...baseTypes].join("|")} became ${[...headTypes].join("|")}`;
  // Requests may widen; responses may narrow. Anything else can break consumers.
  ctx.add("type-changed", breakingIf(request ? !widened : !narrowed), location, describe);
  return widened || narrowed;
}

function compareConstraints(
  ctx: SchemaComparison,
  b: Json,
  h: Json,
  request: boolean,
  location: string,
): void {
  const { tightened, loosened } = constraintChanges(b, h);
  if (tightened.length > 0) {
    ctx.add(
      "constraint-tightened",
      breakingIf(request),
      location,
      `tightened: ${tightened.join(", ")}`,
    );
  }
  if (loosened.length > 0) {
    ctx.add(
      "constraint-loosened",
      "non-breaking",
      location,
      `loosened: ${loosened.join(", ")}`,
    );
  }
}

function compareProperties(
  ctx: SchemaComparison,
  b: Json,
  h: Json,
  direction: Direction,
  location: string,
  seen: Set<string>,
): void {
  if (!isObject(b.properties) && !isObject(h.properties)) return;
  const request = direction === "request";
  const bp = isObject(b.properties) ? b.properties : {};
  const hp = isObject(h.properties) ? h.properties : {};
  const breq = new Set(Array.isArray(b.required) ? b.required.map(String) : []);
  const hreq = new Set(Array.isArray(h.required) ? h.required.map(String) : []);
  for (const name of Object.keys(bp)) {
    if (name in hp) continue;
    const closed = h.additionalProperties === false;
    ctx.add(
      "property-removed",
      breakingIf(!request || closed),
      child(location, name),
      request && !closed
        ? "the property was removed; servers that allow extra properties ignore it"
        : "the property was removed",
    );
  }
  for (const name of Object.keys(hp)) {
    if (name in bp) continue;
    const required = hreq.has(name);
    ctx.add(
      "property-added",
      breakingIf(request && required),
      child(location, name),
      required ? "a required property was added" : "an optional property was added",
    );
  }
  for (const name of Object.keys(bp).filter((name) => name in hp)) {
    if (!breq.has(name) && hreq.has(name)) {
      ctx.add(
        "property-became-required",
        breakingIf(request),
        child(location, name),
        "the property became required",
      );
    } else if (breq.has(name) && !hreq.has(name)) {
      ctx.add(
        "property-became-optional",
        breakingIf(!request),
        child(location, name),
        "the property became optional",
      );
    }
    compareSchema(ctx, bp[name], hp[name], direction, child(location, name), seen);
  }
}
