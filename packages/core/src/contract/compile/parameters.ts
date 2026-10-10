// Parameters: the `params`, `query`, `headers`, and `cookies` objects of an operation, their
// styles, and the path template they must match.
import type { TSchema } from "typebox";
import { type Dict, isRecord, objectSchema } from "../../base/typebox.ts";
import type { OperationSpec } from "../declare/contract.ts";
import { PARAMETER_DEFAULTS, type ParameterLocation, type ParameterModel } from "../model.ts";
import type { Reporter } from "./diagnostics.ts";
import type { OperationContext } from "./operation.ts";

const RESERVED_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "authorization"]);

/** The declaration field of each location, and the styles HyAPI supports there. */
const LOCATIONS = [
  { field: "params", in: "path", styles: ["simple"] },
  { field: "query", in: "query", styles: ["form", "deepObject"] },
  { field: "headers", in: "header", styles: ["simple"] },
  { field: "cookies", in: "cookie", styles: ["form"] },
] as const;

type Location = (typeof LOCATIONS)[number];

/** Where a parameter is declared, and what it is checked against. */
interface ParameterSite {
  readonly location: Location;
  readonly operationId: string;
  /** The parameter's own location in the declaration, such as `getUser/query/limit`. */
  readonly at: string;
  readonly report: Reporter;
}

/** Reports styles that HyAPI does not support for the location or the schema. */
function checkStyle(
  style: ParameterModel["style"],
  explode: boolean,
  schema: TSchema,
  site: ParameterSite,
): void {
  const { location, report, operationId, at } = site;
  const unsupported = (message: string) =>
    report.error("unsupported-parameter-style", message, operationId, at);
  if (!(location.styles as readonly string[]).includes(style)) {
    unsupported(
      `style '${style}' is not supported for ${location.in} parameters; supported: ${
        location.styles.join(", ")
      }`,
    );
  }
  if (style !== "deepObject") return;
  if (!objectSchema(schema)) unsupported("deepObject requires an object schema");
  if (!explode) unsupported("deepObject requires explode: true");
}

/** Reports header names that OpenAPI ignores, or that repeat case-insensitively. */
function checkHeaderName(name: string, seen: Set<string>, site: ParameterSite): void {
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower)) {
    site.report.error(
      "reserved-header",
      `OpenAPI ignores a header parameter named '${name}'; declare media types in body and responses, and credentials in securitySchemes`,
      site.operationId,
      site.at,
    );
  }
  if (seen.has(lower)) {
    site.report.error(
      "duplicate-header",
      `header '${name}' is declared twice (header names are case-insensitive)`,
      site.operationId,
      site.at,
    );
  }
  seen.add(lower);
}

/** Normalizes one parameter of a location object. */
function normalizeParameter(
  name: string,
  schema: TSchema,
  required: boolean,
  override: Dict,
  seenHeaders: Set<string>,
  site: ParameterSite,
): ParameterModel {
  const { location } = site;
  const defaults = PARAMETER_DEFAULTS[location.in];
  const style = (override.style ?? defaults.style) as ParameterModel["style"];
  const explode = typeof override.explode === "boolean" ? override.explode : defaults.explode;
  checkStyle(style, explode, schema, site);
  if (location.in === "header") checkHeaderName(name, seenHeaders, site);
  if (location.in === "path" && !required) {
    site.report.error(
      "optional-path-parameter",
      `path parameter '${name}' must be required; remove T.Optional`,
      site.operationId,
      site.at,
    );
  }
  return {
    name,
    in: location.in as ParameterLocation,
    required,
    schema,
    style,
    explode,
    hasDefault: isRecord(schema) && "default" in schema,
  };
}

/** Normalizes the parameters of one location (`params`, `query`, `headers`, or `cookies`). */
function normalizeLocation(
  location: Location,
  op: OperationSpec,
  operationId: string,
  ctx: OperationContext,
): ParameterModel[] {
  const { report, inspector } = ctx;
  const declared = op[location.field];
  const styles = isRecord(op.styles) ? op.styles : {};
  const overrides = isRecord(styles[location.field]) ? styles[location.field] as Dict : {};
  const at = `${operationId}/${location.field}`;
  const unknownTarget = (name: string) =>
    report.error(
      "unknown-style-target",
      `'${name}' is not a declared ${location.in} parameter`,
      operationId,
      `${operationId}/styles/${location.field}/${name}`,
    );
  if (declared === undefined) {
    Object.keys(overrides).forEach(unknownTarget);
    return [];
  }
  const object = objectSchema(declared);
  if (object === undefined) {
    report.error(
      "invalid-parameter-schema",
      `${location.field} must be a T.Object schema`,
      operationId,
      at,
    );
    return [];
  }
  inspector.inspect(declared, operationId, at);
  Object.keys(overrides).filter((name) => !(name in object.properties)).forEach(unknownTarget);
  const seenHeaders = new Set<string>();
  return Object.entries(object.properties).map(([name, schema]) =>
    normalizeParameter(
      name,
      schema,
      object.required.has(name),
      isRecord(overrides[name]) ? overrides[name] as Dict : {},
      seenHeaders,
      { location, operationId, at: `${at}/${name}`, report },
    )
  );
}

/** Normalizes every parameter of an operation and checks them against its path template. */
export function normalizeParameters(
  operationId: string,
  op: OperationSpec,
  pathParameters: readonly string[],
  ctx: OperationContext,
): ParameterModel[] {
  const { report } = ctx;
  const parameters = LOCATIONS.flatMap((location) =>
    normalizeLocation(location, op, operationId, ctx)
  );
  const pathNames = parameters.filter((p) => p.in === "path").map((p) => p.name);
  const missing = pathParameters.filter((name) => !pathNames.includes(name));
  const extra = pathNames.filter((name) => !pathParameters.includes(name));
  if (missing.length > 0) {
    report.error(
      "path-parameter-mismatch",
      `path parameters missing from params: ${missing.join(", ")}`,
      operationId,
      `${operationId}/params`,
    );
  }
  if (extra.length > 0) {
    report.error(
      "path-parameter-mismatch",
      `params not in the path: ${extra.join(", ")}`,
      operationId,
      `${operationId}/params`,
    );
  }
  return parameters;
}
