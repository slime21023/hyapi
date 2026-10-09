import type { TSchema } from "typebox";
import type { Reporter } from "./diagnostics.ts";
import { isSchema, schemaName } from "./schema.ts";

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

/** Creates an inspector that accepts the standard formats and the API's declared `formats`. */
export function createInspector(report: Reporter, declaredFormats: ReadonlySet<string>): Inspector {
  const schemas = new Map<string, TSchema>();

  const register = (schema: TSchema, operationId: string | undefined, at: string) => {
    const name = schemaName(schema);
    if (name === undefined) return;
    if (!COMPONENT_NAME.test(name)) {
      report.error(
        "invalid-component-name",
        `schema name '${name}' may contain only letters, digits, '.', '-', and '_'`,
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
  };

  const knownFormat = (format: string) =>
    STANDARD_FORMATS.has(format) || ANNOTATION_FORMATS.has(format) || declaredFormats.has(format);

  const inspect = (root: unknown, operationId: string | undefined, location: string) => {
    const stack = new Set<object>();
    const visit = (node: unknown, at: string, scope: ReadonlySet<string>) => {
      if (typeof node !== "object" || node === null || stack.has(node)) return;
      stack.add(node);
      const schema = node as Dict;
      register(node as TSchema, operationId, at);
      if ("~codec" in schema) {
        report.error(
          "unsupported-schema",
          "codecs transform values in code and cannot be represented in JSON Schema",
          operationId,
          at,
        );
      }
      if ("~refine" in schema) {
        report.error(
          "unsupported-schema",
          "refinements check values in code and cannot be represented in JSON Schema",
          operationId,
          at,
        );
      }
      if (typeof schema.format === "string" && !knownFormat(schema.format)) {
        report.error(
          "unknown-format",
          `format '${schema.format}' is neither a standard format nor declared in ` +
            "defineApi({ formats }); declare it there or remove it, so that documentation and " +
            "validation agree",
          operationId,
          at,
        );
      }
      if (typeof schema.type === "string" && NON_JSON_TYPES.has(schema.type)) {
        report.error(
          "unsupported-schema",
          `the '${schema.type}' type cannot be represented in JSON Schema`,
          operationId,
          at,
        );
      }
      let inner = scope;
      if (isRecord(schema.$defs)) inner = new Set([...scope, ...Object.keys(schema.$defs)]);
      if (
        typeof schema.$ref === "string" && !schema.$ref.startsWith("#") && !inner.has(schema.$ref)
      ) {
        report.error(
          "unresolved-reference",
          `'$ref: ${schema.$ref}' does not refer to a definition in an enclosing T.Cyclic`,
          operationId,
          at,
        );
      }
      for (const keyword of MAP_KEYWORDS) {
        const map = schema[keyword];
        if (isRecord(map)) {
          for (const [key, value] of Object.entries(map)) {
            visit(value, `${at}/${keyword}/${key}`, inner);
          }
        }
      }
      for (const keyword of SCHEMA_KEYWORDS) visit(schema[keyword], `${at}/${keyword}`, inner);
      for (const keyword of ARRAY_KEYWORDS) {
        const list = schema[keyword];
        if (Array.isArray(list)) {
          list.forEach((value, i) => visit(value, `${at}/${keyword}/${i}`, inner));
        }
      }
      stack.delete(node);
    };
    visit(root, location, new Set());
  };

  const warnIfUnnamed = (schema: TSchema, operationId: string, at: string) => {
    if (objectSchema(schema) && schemaName(schema) === undefined) {
      report.warn(
        "unnamed-schema",
        "this object schema is emitted inline; name it with defineSchema so that consumers' code " +
          "generators produce a meaningful type name",
        operationId,
        at,
      );
    }
  };

  return { inspect, warnIfUnnamed, schemas };
}
