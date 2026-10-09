import type { TSchema } from "typebox";
import type { Reporter } from "./diagnostics.ts";
import { isSchema, Problem, schemaName } from "./schema.ts";

export type Dict = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/;

const NON_JSON_TYPES: ReadonlySet<string> = new Set([
  "function",
  "constructor",
  "undefined",
  "void",
  "bigint",
  "symbol",
  "promise",
  "iterator",
  "asyncIterator",
]);
const MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "dependentSchemas"] as const;
const SCHEMA_KEYWORDS = [
  "additionalProperties",
  "items",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;
const ARRAY_KEYWORDS = ["anyOf", "allOf", "oneOf", "prefixItems"] as const;

/** Inspects schemas for constructs JSON Schema cannot represent, and collects named schemas. */
export interface Inspector {
  /** Checks a schema tree and registers every named schema in it. */
  inspect(root: unknown, operationId: string | undefined, location: string): void;
  /** Warns when an object schema is emitted inline. */
  warnIfUnnamed(schema: TSchema, operationId: string, location: string): void;
  /** Named schemas in first-reference order. */
  readonly schemas: ReadonlyMap<string, TSchema>;
}

/** What one walk over a schema tree reports to and collects into. */
interface Walk {
  readonly report: Reporter;
  readonly schemas: Map<string, TSchema>;
  readonly knownFormat: (format: string) => boolean;
  readonly operationId: string | undefined;
  /** Nodes on the current path, so that cyclic references end the walk. */
  readonly path: Set<object>;
}

/** Registers a named schema, reporting invalid, reserved, and conflicting names. */
function registerSchema(schema: TSchema, at: string, walk: Walk): void {
  const name = schemaName(schema);
  if (name === undefined) return;
  const { report, schemas, operationId } = walk;
  if (!COMPONENT_NAME.test(name)) {
    report.error(
      "invalid-component-name",
      `schema name '${name}' may contain only letters, digits, '.', '-', and '_'`,
      operationId,
      at,
    );
    return;
  }
  // The name selects application/problem+json, so only the built-in schema may carry it.
  if (name === "Problem" && JSON.stringify(schema) !== JSON.stringify(Problem)) {
    report.error(
      "reserved-schema-name",
      "'Problem' is reserved for the built-in Problem schema; give this schema another name",
      operationId,
      at,
    );
    return;
  }
  const existing = schemas.get(name);
  if (existing === undefined) schemas.set(name, schema);
  else if (existing !== schema && JSON.stringify(existing) !== JSON.stringify(schema)) {
    report.error(
      "duplicate-schema-name",
      `two different schemas are named '${name}'; give each schema a unique name`,
      operationId,
      at,
    );
  }
}

/** Reports what one schema node, without its children, cannot express in JSON Schema. */
function checkSchemaNode(schema: Dict, at: string, scope: ReadonlySet<string>, walk: Walk): void {
  const error = (
    code: "unsupported-schema" | "unknown-format" | "unresolved-reference",
    message: string,
  ) => walk.report.error(code, message, walk.operationId, at);
  if ("~codec" in schema) {
    error(
      "unsupported-schema",
      "codecs transform values in code and cannot be represented in JSON Schema",
    );
  }
  if ("~refine" in schema) {
    error(
      "unsupported-schema",
      "refinements check values in code and cannot be represented in JSON Schema",
    );
  }
  if (typeof schema.format === "string" && !walk.knownFormat(schema.format)) {
    error(
      "unknown-format",
      `format '${schema.format}' is neither a standard format nor declared in ` +
        "defineApi({ formats }); declare it there or remove it, so that documentation and " +
        "validation agree",
    );
  }
  if (typeof schema.type === "string" && NON_JSON_TYPES.has(schema.type)) {
    error("unsupported-schema", `the '${schema.type}' type cannot be represented in JSON Schema`);
  }
  const ref = schema.$ref;
  if (typeof ref === "string" && !ref.startsWith("#") && !scope.has(ref)) {
    error(
      "unresolved-reference",
      `'$ref: ${ref}' does not refer to a definition in an enclosing T.Cyclic`,
    );
  }
}

/** The child schemas of a node, each with its location. */
function childrenOf(schema: Dict, at: string): (readonly [unknown, string])[] {
  const children: (readonly [unknown, string])[] = [];
  for (const keyword of MAP_KEYWORDS) {
    const map = schema[keyword];
    if (!isRecord(map)) continue;
    children.push(
      ...Object.entries(map).map(([key, value]) => [value, `${at}/${keyword}/${key}`] as const),
    );
  }
  for (const keyword of SCHEMA_KEYWORDS) children.push([schema[keyword], `${at}/${keyword}`]);
  for (const keyword of ARRAY_KEYWORDS) {
    const list = schema[keyword];
    if (!Array.isArray(list)) continue;
    children.push(...list.map((value, i) => [value, `${at}/${keyword}/${i}`] as const));
  }
  return children;
}

/** Visits a schema tree depth first. `scope` holds the `$defs` names that `$ref` may use. */
function visitSchema(node: unknown, at: string, scope: ReadonlySet<string>, walk: Walk): void {
  if (typeof node !== "object" || node === null || walk.path.has(node)) return;
  walk.path.add(node);
  const schema = node as Dict;
  registerSchema(node as TSchema, at, walk);
  const inner = isRecord(schema.$defs) ? new Set([...scope, ...Object.keys(schema.$defs)]) : scope;
  checkSchemaNode(schema, at, inner, walk);
  for (const [child, location] of childrenOf(schema, at)) visitSchema(child, location, inner, walk);
  walk.path.delete(node);
}

/** Creates an inspector that accepts the standard formats and the API's declared `formats`. */
export function createInspector(report: Reporter, declaredFormats: ReadonlySet<string>): Inspector {
  const schemas = new Map<string, TSchema>();
  const knownFormat = (format: string) =>
    STANDARD_FORMATS.has(format) || ANNOTATION_FORMATS.has(format) || declaredFormats.has(format);

  const inspect = (root: unknown, operationId: string | undefined, location: string) =>
    visitSchema(root, location, new Set(), {
      report,
      schemas,
      knownFormat,
      operationId,
      path: new Set(),
    });

  const warnIfUnnamed = (schema: TSchema, operationId: string, at: string) => {
    if (!objectSchema(schema) || schemaName(schema) !== undefined) return;
    report.warn(
      "unnamed-schema",
      "this object schema is emitted inline; name it with defineSchema so that consumers' code " +
        "generators produce a meaningful type name",
      operationId,
      at,
    );
  };

  return { inspect, warnIfUnnamed, schemas };
}
