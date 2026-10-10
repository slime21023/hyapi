// The contract component: declaration, inference, normalization, and diagnostics.
// See _adr/components/contract.md, ADR 0004, and RFC 0001.
export type { HttpMethod } from "../base/http.ts";
export { type Api, defineApi, type FormatChecks } from "./declare/api.ts";
export {
  type AnyContract,
  type BodySpec,
  type Contract,
  defineContract,
  type OperationSpec,
  type ResponseValue,
  type StyleOverrides,
} from "./declare/contract.ts";
export { defineResponse, type NamedResponse, type ResponseSpec } from "./declare/response.ts";
export { defineSchema, HealthReport, Problem } from "./declare/schema.ts";
export {
  apiKey,
  type BasicCredential,
  type BasicScheme,
  type BasicSpec,
  defineSecurity,
  httpBasic,
  httpBearer,
  oauth2,
  openIdConnect,
  type Requirement,
  type Scheme,
  type Schemes,
  type Security,
} from "./declare/security.ts";
export type { InputOf, ResultOf } from "./infer.ts";
export type { ApiInfo, OAuthFlow, OAuthFlows, SchemeSpec, ServerSpec, TagSpec } from "./model.ts";
export { checkContracts, type CheckResult } from "./compile/compile.ts";
export { ContractError, type Diagnostic, type DiagnosticCode } from "./compile/diagnostics.ts";
