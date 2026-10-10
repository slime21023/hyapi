import type { TSchema } from "typebox";
import type { HttpMethod } from "../base/http.ts";

/**
 * The single, normalized interpretation of an API. The runtime and the OpenAPI emitter read only
 * this model, never raw declarations (ADR 0002 §2). It is internal to `@hyapi/core` and deeply
 * frozen (ADR 0003 §2, §7).
 */
export interface ContractModel {
  readonly info: ApiInfo;
  readonly servers: readonly ServerSpec[];
  readonly tags: readonly TagSpec[];
  /** Custom formats declared with `defineApi({ formats })`. */
  readonly formats: readonly FormatModel[];
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

/** API metadata emitted as the OpenAPI `info` object. */
export interface ApiInfo {
  readonly title: string;
  readonly version: string;
  readonly summary?: string;
  readonly description?: string;
  readonly termsOfService?: string;
  readonly contact?: { readonly name?: string; readonly url?: string; readonly email?: string };
  readonly license?: { readonly name: string; readonly identifier?: string; readonly url?: string };
}

/** A server URL emitted in the OpenAPI document. */
export interface ServerSpec {
  readonly url: string;
  readonly description?: string;
}

/** Documentation for a tag used by operations. */
export interface TagSpec {
  readonly name: string;
  readonly description?: string;
}

/** An OAuth 2 flow as declared in OpenAPI. */
interface OAuthFlow {
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly refreshUrl?: string;
  readonly scopes: Readonly<Record<string, string>>;
}

/** The OAuth 2 flows of a scheme. At least one flow is required. */
export interface OAuthFlows {
  readonly implicit?: OAuthFlow;
  readonly password?: OAuthFlow;
  readonly clientCredentials?: OAuthFlow;
  readonly authorizationCode?: OAuthFlow;
}

/** The OpenAPI description of a security scheme. */
export type SchemeSpec =
  | {
    readonly type: "http";
    readonly scheme: "bearer";
    readonly bearerFormat?: string;
    readonly description?: string;
  }
  | { readonly type: "http"; readonly scheme: "basic"; readonly description?: string }
  | {
    readonly type: "apiKey";
    readonly in: "header" | "query" | "cookie";
    readonly name: string;
    readonly description?: string;
  }
  | { readonly type: "oauth2"; readonly flows: OAuthFlows; readonly description?: string }
  | {
    readonly type: "openIdConnect";
    readonly openIdConnectUrl: string;
    readonly description?: string;
  };

/** A custom format and its check. */
export interface FormatModel {
  readonly name: string;
  readonly check: (value: string) => boolean;
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

/** OpenAPI's default `style` and `explode` per parameter location. */
export const PARAMETER_DEFAULTS: Readonly<
  Record<
    ParameterLocation,
    { readonly style: ParameterModel["style"]; readonly explode: boolean }
  >
> = {
  path: { style: "simple", explode: false },
  query: { style: "form", explode: true },
  header: { style: "simple", explode: false },
  cookie: { style: "form", explode: true },
};

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

interface NamedSchemaModel {
  readonly name: string;
  readonly schema: TSchema;
}

export interface NamedResponseModel {
  readonly name: string;
  readonly response: Omit<ResponseModel, "status" | "name">;
}
