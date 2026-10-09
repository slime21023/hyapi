import type { TSchema } from "typebox";
import type { AnyContract, HttpMethod, OperationSpec } from "./define.ts";
import type { Reporter } from "./diagnostics.ts";
import { COMPONENT_NAME, type Dict, type Inspector, isRecord, objectSchema } from "./inspect.ts";
import type {
  BodyModel,
  HeaderModel,
  NamedResponseModel,
  OperationModel,
  ParameterLocation,
  ParameterModel,
  RequirementModel,
  ResponseModel,
} from "./model.ts";
import { normalizeRequirements } from "./normalize_security.ts";
import { reasonPhrase } from "./reason.ts";
import { isNamedResponse, type NamedResponse, type ResponseSpec } from "./response.ts";
import { isSchema, schemaName } from "./schema.ts";
import type { SchemeSpec } from "./security.ts";

const JSON_TYPE = "application/json";
const PROBLEM_TYPE = "application/problem+json";
const METHODS: ReadonlySet<string> = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const RESERVED_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "authorization"]);

/** OpenAPI's style and explode defaults, and the styles HyAPI supports, per location. */
export const LOCATIONS = [
  { field: "params", in: "path", style: "simple", explode: false, styles: ["simple"] },
  { field: "query", in: "query", style: "form", explode: true, styles: ["form", "deepObject"] },
  { field: "headers", in: "header", style: "simple", explode: false, styles: ["simple"] },
  { field: "cookies", in: "cookie", style: "form", explode: true, styles: ["form"] },
] as const;

/** Everything an operation is normalized against. */
export interface OperationContext {
  readonly report: Reporter;
  readonly inspector: Inspector;
  readonly schemes: ReadonlyMap<string, SchemeSpec>;
  /** Named responses collected so far, keyed by name, in first-reference order. */
  readonly responses: Map<string, { declared: NamedResponse; model: NamedResponseModel }>;
  readonly rootSecurity: RequirementModel[] | undefined;
}

/** Parses a path template into its parameter names. */
export function parsePath(path: unknown): { params: string[] } | { error: string } {
  if (typeof path !== "string" || !path.startsWith("/")) {
    return { error: "the path must be a string that starts with '/'" };
  }
  if (/[?#]/.test(path)) return { error: "the path must not contain a query string or fragment" };
  const params: string[] = [];
  for (const match of path.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1]!;
    if (!PARAMETER_NAME.test(name)) {
      return { error: `path parameter '{${name}}' must be an identifier` };
    }
    if (params.includes(name)) return { error: `path parameter '{${name}}' appears twice` };
    params.push(name);
  }
  if (/[{}]/.test(path.replace(/\{[^{}]*\}/g, ""))) {
    return { error: "the path has unbalanced braces" };
  }
  return { params };
}

function normalizeParameters(
  operationId: string,
  op: OperationSpec,
  pathParameters: readonly string[],
  ctx: OperationContext,
): ParameterModel[] {
  const { report, inspector } = ctx;
  const parameters: ParameterModel[] = [];
  const styles = isRecord(op.styles) ? op.styles : {};
  for (const location of LOCATIONS) {
    const declared = op[location.field];
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
      continue;
    }
    const object = objectSchema(declared);
    if (object === undefined) {
      report.error(
        "invalid-parameter-schema",
        `${location.field} must be a T.Object schema`,
        operationId,
        at,
      );
      continue;
    }
    inspector.inspect(declared, operationId, at);
    Object.keys(overrides).filter((name) => !(name in object.properties)).forEach(unknownTarget);
    const seenHeaders = new Set<string>();
    for (const [name, schema] of Object.entries(object.properties)) {
      const paramAt = `${at}/${name}`;
      const override = isRecord(overrides[name]) ? overrides[name] as Dict : {};
      const style = (override.style ?? location.style) as ParameterModel["style"];
      const explode = typeof override.explode === "boolean" ? override.explode : location.explode;
      if (!(location.styles as readonly string[]).includes(style)) {
        report.error(
          "unsupported-parameter-style",
          `style '${style}' is not supported for ${location.in} parameters; supported: ${
            location.styles.join(", ")
          }`,
          operationId,
          paramAt,
        );
      }
      if (style === "deepObject") {
        if (!objectSchema(schema)) {
          report.error(
            "unsupported-parameter-style",
            "deepObject requires an object schema",
            operationId,
            paramAt,
          );
        }
        if (!explode) {
          report.error(
            "unsupported-parameter-style",
            "deepObject requires explode: true",
            operationId,
            paramAt,
          );
        }
      }
      if (location.in === "header") {
        const lower = name.toLowerCase();
        if (RESERVED_HEADERS.has(lower)) {
          report.error(
            "reserved-header",
            `OpenAPI ignores a header parameter named '${name}'; declare media types in body and responses, and credentials in securitySchemes`,
            operationId,
            paramAt,
          );
        }
        if (seenHeaders.has(lower)) {
          report.error(
            "duplicate-header",
            `header '${name}' is declared twice (header names are case-insensitive)`,
            operationId,
            paramAt,
          );
        }
        seenHeaders.add(lower);
      }
      const required = object.required.has(name);
      if (location.in === "path" && !required) {
        report.error(
          "optional-path-parameter",
          `path parameter '${name}' must be required; remove T.Optional`,
          operationId,
          paramAt,
        );
      }
      parameters.push({
        name,
        in: location.in as ParameterLocation,
        required,
        schema,
        style,
        explode,
        hasDefault: isRecord(schema) && "default" in schema,
      });
    }
  }

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

function normalizeBody(
  operationId: string,
  op: OperationSpec,
  ctx: OperationContext,
): BodyModel | undefined {
  if (op.body === undefined) return undefined;
  const { report, inspector } = ctx;
  const at = `${operationId}/body`;
  const full = isSchema(op.body) ? undefined : op.body as Dict;
  const schema = full === undefined ? op.body as TSchema : full.schema;
  if (!isSchema(schema)) {
    report.error(
      "invalid-body",
      "body must be a schema or { schema, mediaType?, required?, description? }",
      operationId,
      at,
    );
    return undefined;
  }
  const mediaType = typeof full?.mediaType === "string" ? full.mediaType : JSON_TYPE;
  if (!MEDIA_TYPE.test(mediaType)) {
    report.error("invalid-media-type", `'${mediaType}' is not a media type`, operationId, at);
  }
  if (op.method === "GET" || op.method === "HEAD") {
    report.warn(
      "body-on-safe-method",
      `${op.method} requests should not have a body; many clients and proxies drop it`,
      operationId,
      at,
    );
  }
  inspector.inspect(schema, operationId, at);
  inspector.warnIfUnnamed(schema, operationId, at);
  return {
    schema,
    mediaType,
    required: full?.required !== false,
    ...(typeof full?.description === "string" ? { description: full.description } : {}),
  };
}

/** Normalizes one response declaration (schema or full form). */
function normalizeResponse(
  spec: ResponseSpec,
  operationId: string,
  at: string,
  ctx: OperationContext,
): Omit<ResponseModel, "status" | "name"> {
  const { report, inspector } = ctx;
  let body: ResponseModel["body"];
  if (spec.body !== undefined) {
    if (!isSchema(spec.body)) {
      report.error(
        "invalid-response",
        "a response body must be a schema",
        operationId,
        `${at}/body`,
      );
    } else {
      // Matched by component name, not identity, so a second copy of HyAPI (for example the
      // CLI's) still recognizes the built-in Problem schema.
      const mediaType = spec.mediaType ??
        (schemaName(spec.body) === "Problem" ? PROBLEM_TYPE : JSON_TYPE);
      if (!MEDIA_TYPE.test(mediaType)) {
        report.error(
          "invalid-media-type",
          `'${mediaType}' is not a media type`,
          operationId,
          `${at}/mediaType`,
        );
      }
      inspector.inspect(spec.body, operationId, `${at}/body`);
      inspector.warnIfUnnamed(spec.body, operationId, `${at}/body`);
      body = { schema: spec.body, mediaType };
    }
  }
  const headers: HeaderModel[] = [];
  if (spec.headers !== undefined) {
    const object = objectSchema(spec.headers);
    if (object === undefined) {
      report.error(
        "invalid-response",
        "response headers must be a T.Object schema",
        operationId,
        `${at}/headers`,
      );
    } else {
      inspector.inspect(spec.headers, operationId, `${at}/headers`);
      const seen = new Set<string>();
      for (const [name, schema] of Object.entries(object.properties)) {
        const lower = name.toLowerCase();
        if (seen.has(lower)) {
          report.error(
            "duplicate-header",
            `response header '${name}' is declared twice (header names are case-insensitive)`,
            operationId,
            `${at}/headers/${name}`,
          );
        }
        seen.add(lower);
        headers.push({ name, required: object.required.has(name), schema });
      }
    }
  }
  return {
    description: spec.description,
    ...(body === undefined ? {} : { body }),
    headers,
  };
}

/** Normalizes a `defineResponse` value once, and reuses it wherever it is referenced. */
function namedResponse(
  declared: NamedResponse,
  operationId: string,
  at: string,
  ctx: OperationContext,
): Omit<ResponseModel, "status"> {
  const existing = ctx.responses.get(declared.name);
  if (existing !== undefined) {
    if (existing.declared !== declared) {
      ctx.report.error(
        "duplicate-response-name",
        `two different responses are named '${declared.name}'; give each response a unique name`,
        operationId,
        at,
      );
    }
    return { ...existing.model.response, name: declared.name };
  }
  if (!COMPONENT_NAME.test(declared.name)) {
    ctx.report.error(
      "invalid-component-name",
      `response name '${declared.name}' may contain only letters, digits, '.', '-', and '_'`,
      operationId,
      at,
    );
  }
  const response = normalizeResponse(declared.spec, operationId, at, ctx);
  ctx.responses.set(declared.name, { declared, model: { name: declared.name, response } });
  return { ...response, name: declared.name };
}

function normalizeResponses(
  operationId: string,
  op: OperationSpec,
  ctx: OperationContext,
): ResponseModel[] {
  const { report } = ctx;
  const models: ResponseModel[] = [];
  const entries = isRecord(op.responses) ? Object.entries(op.responses) : [];
  if (entries.length === 0) {
    report.error(
      "no-responses",
      "an operation must declare at least one response",
      operationId,
      `${operationId}/responses`,
    );
  }
  for (const [key, value] of entries as [string, unknown][]) {
    const at = `${operationId}/responses/${key}`;
    const status = Number(key);
    if (!Number.isInteger(status) || status < 100 || status > 599 || String(status) !== key) {
      report.error(
        "invalid-status",
        `'${key}' is not an HTTP status code between 100 and 599`,
        operationId,
        at,
      );
      continue;
    }
    let model: Omit<ResponseModel, "status"> | undefined;
    if (isNamedResponse(value)) {
      model = namedResponse(value, operationId, at, ctx);
    } else if (isSchema(value)) {
      model = normalizeResponse(
        { description: reasonPhrase(status), body: value },
        operationId,
        at,
        ctx,
      );
    } else if (isRecord(value) && typeof value.description === "string") {
      model = normalizeResponse(value as unknown as ResponseSpec, operationId, at, ctx);
    } else {
      report.error(
        "invalid-response",
        "a response must be a schema, { description, body?, mediaType?, headers? }, or a defineResponse value",
        operationId,
        at,
      );
    }
    if (model === undefined) continue;
    if (model.body && (status < 200 || status === 204 || status === 205 || status === 304)) {
      report.error(
        "body-not-allowed",
        `status ${status} responses cannot have a body`,
        operationId,
        at,
      );
    }
    models.push({ status, ...model });
  }
  return models.sort((a, b) => a.status - b.status);
}

/** Normalizes one operation; undefined when it is not even an object. */
export function normalizeOperation(
  operationId: string,
  op: OperationSpec,
  contractIndex: number,
  contract: AnyContract,
  contractSecurity: RequirementModel[] | undefined,
  ctx: OperationContext,
): OperationModel | undefined {
  const { report } = ctx;
  if (!isRecord(op)) {
    report.error("invalid-api", "an operation must be an object", operationId, operationId);
    return undefined;
  }
  if (!METHODS.has(op.method)) {
    report.error(
      "invalid-method",
      `'${String(op.method)}' is not an HTTP method`,
      operationId,
      `${operationId}/method`,
    );
  }
  const parsed = parsePath(op.path);
  if ("error" in parsed) {
    report.error("invalid-path", parsed.error, operationId, `${operationId}/path`);
  }
  const pathParameters = "params" in parsed ? parsed.params : [];
  const parameters = normalizeParameters(operationId, op, pathParameters, ctx);
  const body = normalizeBody(operationId, op, ctx);
  const responses = normalizeResponses(operationId, op, ctx);

  // The effective requirement: the operation's own, then the contract's, then the API's.
  let security: RequirementModel[];
  let securityOrigin: OperationModel["securityOrigin"];
  if (op.security !== undefined) {
    security = normalizeRequirements(
      op.security,
      ctx.schemes,
      report,
      operationId,
      `${operationId}/security`,
    );
    securityOrigin = "operation";
  } else if (contractSecurity !== undefined) {
    security = contractSecurity;
    securityOrigin = "contract";
  } else if (ctx.rootSecurity !== undefined) {
    security = ctx.rootSecurity;
    securityOrigin = "api";
  } else {
    security = [];
    securityOrigin = "none";
  }

  return {
    operationId,
    method: op.method,
    path: typeof op.path === "string" ? op.path : "",
    pathParameters,
    parameters,
    ...(body === undefined ? {} : { body }),
    responses,
    security,
    securityOrigin,
    tags: [...(op.tags ?? contract.tags ?? [])],
    ...(op.summary === undefined ? {} : { summary: op.summary }),
    ...(op.description === undefined ? {} : { description: op.description }),
    deprecated: op.deprecated === true,
    contract: contractIndex,
  };
}
