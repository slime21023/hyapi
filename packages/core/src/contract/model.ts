import type { TSchema } from "typebox";
import type { ApiInfo, HttpMethod, ServerSpec, TagSpec } from "./define.ts";
import type { SchemeSpec } from "./security.ts";

/**
 * The single, normalized interpretation of an API. The runtime and the OpenAPI emitter read only
 * this model, never raw declarations (ADR 0002 §2). Its shape is not a compatibility promise for
 * application code.
 */
export interface ContractModel {
  readonly info: ApiInfo;
  readonly servers: readonly ServerSpec[];
  readonly tags: readonly TagSpec[];
  /** Security schemes in declaration order. */
  readonly securitySchemes: readonly SecuritySchemeModel[];
  /** The root requirement, or `undefined` when the API declares none. */
  readonly security: readonly RequirementModel[] | undefined;
  /** Operations in contract order, then declaration order. */
  readonly operations: readonly OperationModel[];
  /** Named schemas in first-reference order. */
  readonly schemas: readonly NamedSchemaModel[];
  /** Named responses in first-reference order. */
  readonly responses: readonly NamedResponseModel[];
}

export interface SecuritySchemeModel {
  readonly name: string;
  readonly spec: SchemeSpec;
}

/** One requirement: every scheme must succeed. */
export type RequirementModel = readonly {
  readonly scheme: string;
  readonly scopes: readonly string[];
}[];

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface ParameterModel {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required: boolean;
  readonly schema: TSchema;
  readonly style: "simple" | "form" | "deepObject";
  readonly explode: boolean;
  /** Present when the schema declares a `default`, which the runtime applies when absent. */
  readonly hasDefault: boolean;
}

export interface BodyModel {
  readonly schema: TSchema;
  readonly mediaType: string;
  readonly required: boolean;
  readonly description?: string;
}

export interface HeaderModel {
  readonly name: string;
  readonly required: boolean;
  readonly schema: TSchema;
}

export interface ResponseModel {
  readonly status: number;
  readonly description: string;
  readonly body?: { readonly schema: TSchema; readonly mediaType: string };
  readonly headers: readonly HeaderModel[];
  /** The component name when the response was declared with `defineResponse`. */
  readonly name?: string;
}

export interface OperationModel {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  /** Path template parameters in template order. */
  readonly pathParameters: readonly string[];
  readonly parameters: readonly ParameterModel[];
  readonly body?: BodyModel;
  /** Responses ordered by status. */
  readonly responses: readonly ResponseModel[];
  /** The effective requirement. An empty list means the operation is public. */
  readonly security: readonly RequirementModel[];
  /** Where the effective requirement came from. */
  readonly securityOrigin: "operation" | "contract" | "api" | "none";
  readonly tags: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly deprecated: boolean;
  /** Index of the declaring contract in `defineApi({ contracts })`. */
  readonly contract: number;
}

export interface NamedSchemaModel {
  readonly name: string;
  readonly schema: TSchema;
}

export interface NamedResponseModel {
  readonly name: string;
  readonly response: Omit<ResponseModel, "status" | "name">;
}
