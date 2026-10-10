// The named components of one API: schemas named with `defineSchema` and responses declared with
// `defineResponse`, collected in first-reference order under one naming rule.
import type { TSchema } from "typebox";
import { schemaName } from "../../base/typebox.ts";
import type { NamedResponse } from "../declare/response.ts";
import { Problem } from "../declare/schema.ts";
import type { NamedResponseModel, ResponseModel } from "../model.ts";
import type { Reporter } from "./diagnostics.ts";

/** The names that OpenAPI accepts under `#/components`. */
const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/;

/** A response's model without its status and name, as one declaration produces it. */
type ResponseContent = NamedResponseModel["response"];

/** The named schemas and responses of one API. */
export interface Components {
  /** Registers a schema if it is named, reporting invalid, reserved, and conflicting names. */
  addSchema(schema: TSchema, operationId: string | undefined, at: string): void;
  /**
   * Returns a named response, normalizing it on its first reference and reusing it afterwards.
   * `normalize` runs at most once per name.
   */
  addResponse(
    declared: NamedResponse,
    operationId: string,
    at: string,
    normalize: () => ResponseContent,
  ): Omit<ResponseModel, "status">;
  /** Named schemas in first-reference order. */
  readonly schemas: ReadonlyMap<string, TSchema>;
  /** Named responses in first-reference order. */
  readonly responses: ReadonlyMap<string, NamedResponseModel>;
}

/** What the registry holds while one API is compiled. */
interface Registry {
  readonly report: Reporter;
  readonly schemas: Map<string, TSchema>;
  readonly responses: Map<string, NamedResponseModel>;
  /** The declaration behind each named response, to detect two responses with one name. */
  readonly declarations: Map<string, NamedResponse>;
}

/** Registers a named schema, reporting invalid, reserved, and conflicting names. */
function addSchema(
  registry: Registry,
  schema: TSchema,
  operationId: string | undefined,
  at: string,
): void {
  const name = schemaName(schema);
  if (name === undefined) return;
  const { report, schemas } = registry;
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

/** Normalizes a `defineResponse` value once, and reuses it wherever it is referenced. */
function addResponse(
  registry: Registry,
  declared: NamedResponse,
  operationId: string,
  at: string,
  normalize: () => ResponseContent,
): Omit<ResponseModel, "status"> {
  const { report, responses, declarations } = registry;
  const existing = responses.get(declared.name);
  if (existing !== undefined) {
    if (declarations.get(declared.name) !== declared) {
      report.error(
        "duplicate-response-name",
        `two different responses are named '${declared.name}'; give each response a unique name`,
        operationId,
        at,
      );
    }
    return { ...existing.response, name: declared.name };
  }
  if (!COMPONENT_NAME.test(declared.name)) {
    report.error(
      "invalid-component-name",
      `response name '${declared.name}' may contain only letters, digits, '.', '-', and '_'`,
      operationId,
      at,
    );
  }
  const response = normalize();
  declarations.set(declared.name, declared);
  responses.set(declared.name, { name: declared.name, response });
  return { ...response, name: declared.name };
}

/** Creates an empty registry for one API. */
export function createComponents(report: Reporter): Components {
  const registry: Registry = {
    report,
    schemas: new Map(),
    responses: new Map(),
    declarations: new Map(),
  };
  return {
    addSchema: (schema, operationId, at) => addSchema(registry, schema, operationId, at),
    addResponse: (declared, operationId, at, normalize) =>
      addResponse(registry, declared, operationId, at, normalize),
    schemas: registry.schemas,
    responses: registry.responses,
  };
}
