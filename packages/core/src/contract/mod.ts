// The contract component: declaration, inference, normalization, and diagnostics.
// See _adr/components/contract.md and RFC 0001.
export {
  type AnyContract,
  type Api,
  type ApiInfo,
  type BodySpec,
  type Contract,
  defineApi,
  defineContract,
  type HttpMethod,
  type OperationMap,
  type OperationSpec,
  type PathParams,
  type ResponseValue,
  type ServerSpec,
  type StyleOverrides,
  type TagSpec,
} from "./define.ts";
export type { InputOf, OperationOf, ResultOf, SecurityFor, SecurityOf } from "./infer.ts";
export { defineResponse, type NamedResponse, type ResponseSpec } from "./response.ts";
export { defineSchema, HealthReport, Problem } from "./schema.ts";
export {
  apiKey,
  type BasicCredential,
  type CredentialOf,
  defineSecurity,
  httpBasic,
  httpBearer,
  type IdentityOf,
  oauth2,
  type OAuthFlow,
  type OAuthFlows,
  openIdConnect,
  type Requirement,
  type Scheme,
  type Schemes,
  type SchemeSpec,
  type Security,
} from "./security.ts";
export { checkContracts, type CheckResult, type Diagnostic, type DiagnosticCode } from "./check.ts";
export type {
  BodyModel,
  ContractModel,
  HeaderModel,
  NamedResponseModel,
  NamedSchemaModel,
  OperationModel,
  ParameterLocation,
  ParameterModel,
  RequirementModel,
  ResponseModel,
  SecuritySchemeModel,
} from "./model.ts";
