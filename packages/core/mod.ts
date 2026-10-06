/**
 * HyAPI's public application API.
 *
 * Compose an application from modules and plugins, connect modules through Ports, and expose
 * HTTP contracts without coupling application code to a transport.
 *
 * @module
 */
export { createApplication, defineModule } from "./src/app.ts";
export {
  AppError,
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ResponseContractError,
  ResponseValidationError,
  UnauthorizedError,
  ValidationError,
} from "./src/errors.ts";
export { anyOf, defineGuard, requireScopes } from "./src/guards.ts";
export type { Guard, GuardContext, GuardSecurity } from "./src/guards.ts";
export {
  definePort,
  definePortContract,
  formatContractVersion,
  isCompatibleContractVersion,
  providePort,
  verifyPortContract,
  verifyPortContracts,
} from "./src/port.ts";
export { defineHttpContract } from "./src/http/contract.ts";
export { registerHttpContract } from "./src/http/server.ts";
export { createHttpClient, createHttpHealthCheck, withHttpContext } from "./src/http/client.ts";
export { provideHttp } from "./src/http/provider.ts";
export { ResilienceError, withResilience } from "./src/resilience.ts";
export { defineConfig } from "./src/config.ts";
export { defineStateKey } from "./src/state.ts";
export type { RequestState, StateKey } from "./src/state.ts";
export type {
  AnyRouteDefinition,
  ApplicationOptions,
  HyApplication,
  Identity,
  LifecycleContext,
  LifecycleHook,
  Module,
  ModuleApi,
  PlatformApi,
  Plugin,
  RequestContext,
  ResponseResult,
  ResponseSchemas,
  RouteDefinition,
  RouteGroupApi,
  RouteGroupOptions,
  RouteHandler,
  RouteMetadata,
  RouteRequestSchemas,
  Schema,
  ServiceOverride,
  ServiceReference,
} from "./src/types.ts";
export type { AppConfig, AppConfigOptions } from "./src/config.ts";
export type {
  OpenApiConfig,
  OpenApiConfigOptions,
  OpenApiDocument,
  OpenApiDocumentOptions,
} from "./src/openapi.ts";
export type {
  ContractVersion,
  Port,
  PortContract,
  PortProvider,
  ProviderLifecycle,
} from "./src/port.ts";
export type {
  HealthCheck,
  HealthCheckReport,
  HealthCheckResult,
  HealthReport,
  HealthStatus,
} from "./src/health.ts";
export type {
  BulkheadPolicy,
  CircuitBreakerPolicy,
  ResiliencePolicy,
  RetryPolicy,
} from "./src/resilience.ts";
export type {
  AnyHttpContractRoute,
  HttpContract,
  HttpContractRoute,
  HttpContractRoutes,
} from "./src/http/contract.ts";
export type { HttpContractHandler, HttpContractHandlers } from "./src/http/server.ts";
export type {
  HttpClient,
  HttpClientOptions,
  HttpHealthCheckOptions,
  HttpPropagationSource,
} from "./src/http/client.ts";
export type { HttpPortOptions } from "./src/http/provider.ts";
