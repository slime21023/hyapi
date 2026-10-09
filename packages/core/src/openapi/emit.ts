import { compileContracts } from "../contract/check.ts";
import type { Api } from "../contract/define.ts";
import { ContractError } from "../contract/diagnostics.ts";
import type {
  ContractModel,
  OperationModel,
  ParameterModel,
  RequirementModel,
  ResponseModel,
} from "../contract/model.ts";
import { LOCATIONS } from "../contract/normalize_operation.ts";
import { schemaName } from "../contract/schema.ts";

/** The OpenAPI version HyAPI emits. */
export const OPENAPI_VERSION = "3.1.1";

/** A JSON value in an emitted document. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** An emitted OpenAPI 3.1 document. */
export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly [key: string]: JsonValue;
  };
  readonly [key: string]: JsonValue;
}

type Json = Record<string, JsonValue>;

/**
 * Converts a TypeBox schema to plain JSON Schema. TypeBox's hidden markers are dropped, and every
 * schema named with `defineSchema` becomes a `$ref`, except the component being defined.
 */
function toJsonSchema(schema: unknown, component?: string): JsonValue {
  const visit = (node: unknown, isRoot: boolean): JsonValue => {
    if (Array.isArray(node)) return node.map((item) => visit(item, false));
    if (typeof node !== "object" || node === null) return node as JsonValue;
    const name = schemaName(node);
    if (name !== undefined && !(isRoot && name === component)) {
      return { $ref: `#/components/schemas/${name}` };
    }
    const result: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (value !== undefined) result[key] = visit(value, false);
    }
    return result;
  };
  return visit(schema, true);
}

function requirements(security: readonly RequirementModel[]): JsonValue {
  return security.map((requirement) =>
    Object.fromEntries(requirement.map(({ scheme, scopes }) => [scheme, [...scopes]]))
  );
}

function parameter(model: ParameterModel): Json {
  const schema = model.schema as Record<string, unknown>;
  const result: Json = { name: model.name, in: model.in };
  if (typeof schema.description === "string") result.description = schema.description;
  if (model.required) result.required = true;
  if (schema.deprecated === true) result.deprecated = true;
  // Only differences from OpenAPI's defaults for the location are emitted.
  const defaults = LOCATIONS.find((location) => location.in === model.in)!;
  if (model.style !== defaults.style) result.style = model.style;
  if (model.explode !== defaults.explode) result.explode = model.explode;
  result.schema = toJsonSchema(model.schema);
  return result;
}

function response(model: Omit<ResponseModel, "status" | "name">): Json {
  const result: Json = { description: model.description };
  if (model.headers.length > 0) {
    result.headers = Object.fromEntries(
      model.headers.map((header) => [
        header.name,
        { ...(header.required ? { required: true } : {}), schema: toJsonSchema(header.schema) },
      ]),
    );
  }
  if (model.body !== undefined) {
    result.content = { [model.body.mediaType]: { schema: toJsonSchema(model.body.schema) } };
  }
  return result;
}

function operation(model: OperationModel): Json {
  const result: Json = { operationId: model.operationId };
  if (model.summary !== undefined) result.summary = model.summary;
  if (model.description !== undefined) result.description = model.description;
  if (model.tags.length > 0) result.tags = [...model.tags];
  if (model.deprecated) result.deprecated = true;
  if (model.parameters.length > 0) result.parameters = model.parameters.map(parameter);
  if (model.body !== undefined) {
    result.requestBody = {
      ...(model.body.description === undefined ? {} : { description: model.body.description }),
      required: model.body.required,
      content: { [model.body.mediaType]: { schema: toJsonSchema(model.body.schema) } },
    };
  }
  result.responses = Object.fromEntries(
    model.responses.map((r) => [
      String(r.status),
      r.name === undefined ? response(r) : { $ref: `#/components/responses/${r.name}` },
    ]),
  );
  // The API root requirement is inherited in OpenAPI; contract defaults have no OpenAPI
  // equivalent, so they are written on each operation.
  if (model.securityOrigin === "operation" || model.securityOrigin === "contract") {
    result.security = requirements(model.security);
  }
  return result;
}

/**
 * Compiles an API's contracts into an OpenAPI 3.1 document. The same contracts always produce the
 * same document, with keys in declaration order.
 *
 * @throws {ContractError} when the contracts have errors; `checkContracts` reports the same
 * diagnostics without throwing.
 */
export function emitOpenApi(api: Api): OpenApiDocument {
  const compiled = compileContracts(api);
  if (!compiled.ok) throw new ContractError(compiled.diagnostics);
  return emitModel(compiled.model);
}

function emitModel(model: ContractModel): OpenApiDocument {
  const document: Json = {
    openapi: OPENAPI_VERSION,
    info: JSON.parse(JSON.stringify(model.info)),
  };
  if (model.servers.length > 0) document.servers = JSON.parse(JSON.stringify(model.servers));
  if (model.tags.length > 0) document.tags = JSON.parse(JSON.stringify(model.tags));
  if (model.security !== undefined) document.security = requirements(model.security);

  const paths: Record<string, Json> = {};
  for (const op of model.operations) {
    (paths[op.path] ??= {})[op.method.toLowerCase()] = operation(op);
  }
  document.paths = paths;

  const components: Json = {};
  if (model.schemas.length > 0) {
    components.schemas = Object.fromEntries(
      model.schemas.map(({ name, schema }) => [name, toJsonSchema(schema, name)]),
    );
  }
  if (model.responses.length > 0) {
    components.responses = Object.fromEntries(
      model.responses.map(({ name, response: r }) => [name, response(r)]),
    );
  }
  if (model.securitySchemes.length > 0) {
    components.securitySchemes = Object.fromEntries(
      model.securitySchemes.map(({ name, spec }) => [name, JSON.parse(JSON.stringify(spec))]),
    );
  }
  if (Object.keys(components).length > 0) document.components = components;
  return document as unknown as OpenApiDocument;
}

/**
 * Serializes a document to the canonical JSON text that is committed to a repository: two-space
 * indentation, LF line endings, and a final newline, which `deno fmt` leaves unchanged.
 */
export function serializeOpenApi(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
