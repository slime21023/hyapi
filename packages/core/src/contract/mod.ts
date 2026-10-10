// The contract component: declaration, inference, normalization, and diagnostics.
// See _adr/components/contract.md, ADR 0004, and RFC 0001. Only the types that applications must
// name are exported; declaration shapes are inferred from the literals passed to define* (RFC 0001
// A38).
export { type Api, defineApi, type FormatChecks } from "./declare/api.ts";
export { type Contract, defineContract } from "./declare/contract.ts";
export { defineResponse } from "./declare/response.ts";
export { defineSchema, HealthReport, Problem } from "./declare/schema.ts";
export {
  apiKey,
  type BasicCredential,
  defineSecurity,
  httpBasic,
  httpBearer,
  oauth2,
  openIdConnect,
  type Scheme,
  type Schemes,
  type Security,
} from "./declare/security.ts";
export type { InputOf, ResultOf } from "./infer.ts";
export { checkContracts, type CheckResult } from "./compile/compile.ts";
export { ContractError, type Diagnostic, type DiagnosticCode } from "./compile/diagnostics.ts";
