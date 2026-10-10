// The schema walk: what one schema tree may contain to be represented in JSON Schema, and which
// named schemas it holds.
import type { TSchema } from "typebox";
import {
  ANNOTATION_FORMATS,
  type Dict,
  hasCodec,
  hasRefinement,
  isRecord,
  objectSchema,
  schemaName,
  STANDARD_FORMATS,
} from "../../base/typebox.ts";
import type { Components } from "./components.ts";
import type { Reporter } from "./diagnostics.ts";

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

/** Inspects schemas for constructs JSON Schema cannot represent, and registers named schemas. */
export interface Inspector {
  /** Checks a schema tree and registers every named schema in it. */
  inspect(root: unknown, operationId: string | undefined, location: string): void;
  /** Warns when an object schema is emitted inline. */
  warnIfUnnamed(schema: TSchema, operationId: string, location: string): void;
}

/** What one walk over a schema tree reports to and collects into. */
interface Walk {
  readonly report: Reporter;
  readonly components: Components;
  readonly knownFormat: (format: string) => boolean;
  readonly operationId: string | undefined;
  /** Nodes on the current path, so that cyclic references end the walk. */
  readonly path: Set<object>;
}

/** Reports what one schema node, without its children, cannot express in JSON Schema. */
function checkSchemaNode(schema: Dict, at: string, scope: ReadonlySet<string>, walk: Walk): void {
  const error = (
    code: "unsupported-schema" | "unknown-format" | "unresolved-reference",
    message: string,
  ) => walk.report.error(code, message, walk.operationId, at);
  if (hasCodec(schema)) {
    error(
      "unsupported-schema",
      "codecs transform values in code and cannot be represented in JSON Schema",
    );
  }
  if (hasRefinement(schema)) {
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
  walk.components.addSchema(node as TSchema, walk.operationId, at);
  const inner = isRecord(schema.$defs) ? new Set([...scope, ...Object.keys(schema.$defs)]) : scope;
  checkSchemaNode(schema, at, inner, walk);
  for (const [child, location] of childrenOf(schema, at)) visitSchema(child, location, inner, walk);
  walk.path.delete(node);
}

/** Creates an inspector that accepts the standard formats and the API's declared `formats`. */
export function createInspector(
  report: Reporter,
  components: Components,
  declaredFormats: ReadonlySet<string>,
): Inspector {
  const knownFormat = (format: string) =>
    STANDARD_FORMATS.has(format) || ANNOTATION_FORMATS.has(format) || declaredFormats.has(format);

  const inspect = (root: unknown, operationId: string | undefined, location: string) =>
    visitSchema(root, location, new Set(), {
      report,
      components,
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

  return { inspect, warnIfUnnamed };
}
