import type { Static, TSchema } from "typebox";
import { validateContractVersion } from "./version.ts";

export type MaybePromise<T> = T | Promise<T>;
export type Schema = TSchema;
export type InferSchema<T extends Schema | undefined> = T extends Schema ? Static<T>
  : unknown;

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "options";

export interface RouteRequestSchemas<
  TParams extends Schema | undefined = Schema | undefined,
  TQuery extends Schema | undefined = Schema | undefined,
  TBody extends Schema | undefined = Schema | undefined,
  THeaders extends Schema | undefined = Schema | undefined,
  TBodyRequired extends boolean = true,
> {
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  bodyRequired?: TBodyRequired;
  headers?: THeaders;
}

export interface RouteMetadata {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: readonly string[];
  deprecated?: boolean;
}

export type AuthRequirement = false | {
  required?: boolean;
  scopes?: readonly string[];
};

export interface Identity {
  subject: string;
  scopes: readonly string[];
  claims: Readonly<Record<string, unknown>>;
}

export interface AuthProvider {
  authenticate(request: Request): MaybePromise<Identity | null>;
}

export interface ResponseResult<T = unknown> {
  readonly __hyapiResponse: true;
  readonly body: T;
  readonly init?: ResponseInit;
}

export type ResponseSchemas = Record<number, Schema>;

export interface RequestContext<
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
  TBodyRequired extends boolean = true,
> {
  readonly request: Request;
  readonly requestId: string;
  readonly requestIdHeader: string;
  /** Epoch-ms deadline: the earlier of `x-hyapi-deadline` and now + `requestTimeoutMs`. */
  readonly deadline: number;
  /** Aborted when the effective deadline passes; long-running handlers should observe it. */
  readonly signal: AbortSignal;
  readonly params: InferSchema<TParams>;
  readonly query: InferSchema<TQuery>;
  readonly body: TBodyRequired extends false ? InferSchema<TBody> | undefined : InferSchema<TBody>;
  readonly headers: Headers;
  identity: Identity | null;
  readonly state: Map<string, unknown>;
  readonly services: ServiceResolver;
  ok<T>(body: T, init?: ResponseInit): ResponseResult<T>;
  created<T>(body: T, init?: ResponseInit): ResponseResult<T>;
  noContent(init?: ResponseInit): ResponseResult<undefined>;
  json<T>(body: T, status?: number, init?: ResponseInit): ResponseResult<T>;
  respond<T>(body: T, init?: ResponseInit): ResponseResult<T>;
}

export interface LifecycleContext {
  readonly request: Request;
  readonly requestId: string;
  readonly state: Map<string, unknown>;
  route: AnyRouteDefinition | null;
  identity: Identity | null;
  response: Response | null;
  error: unknown | null;
}

export type LifecycleHook = (context: LifecycleContext) => MaybePromise<void>;

export type RouteHandler<
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
  TBodyRequired extends boolean = true,
> = (context: RequestContext<TParams, TQuery, TBody, TBodyRequired>) => MaybePromise<unknown>;

export interface RouteDefinition<
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
  TResponse extends ResponseSchemas | undefined = undefined,
  TBodyRequired extends boolean = true,
> {
  method: HttpMethod;
  path: string;
  request?: RouteRequestSchemas<TParams, TQuery, TBody, Schema | undefined, TBodyRequired>;
  responses?: TResponse;
  responseStatus?: number;
  auth?: AuthRequirement;
  metadata?: RouteMetadata;
  handler(context: RequestContext<TParams, TQuery, TBody, TBodyRequired>): MaybePromise<unknown>;
}

export interface RouteGroupOptions {
  prefix?: string | undefined;
  auth?: AuthRequirement | undefined;
  tags?: readonly string[] | undefined;
}

export interface RouteGroupApi {
  addHook(point: "onRequest" | "onResponse" | "onError", hook: LifecycleHook): void;
  route<
    TParams extends Schema | undefined,
    TQuery extends Schema | undefined,
    TBody extends Schema | undefined,
    TResponse extends ResponseSchemas | undefined,
    TBodyRequired extends boolean = true,
  >(route: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired>): void;
  group(
    prefix: string,
    fn: (group: RouteGroupApi) => void,
  ): void;
  group(
    options: RouteGroupOptions,
    fn: (group: RouteGroupApi) => void,
  ): void;
  group(
    prefix: string,
    options: RouteGroupOptions,
    fn: (group: RouteGroupApi) => void,
  ): void;
}

export interface PlatformApi {
  addHook(point: "onRequest" | "onResponse" | "onError", hook: LifecycleHook): void;
  setAuthProvider(provider: AuthProvider): void;
}

export interface Plugin {
  readonly name: string;
  readonly dependencies?: readonly string[];
  setup(platform: PlatformApi): MaybePromise<void>;
  onStart?(platform: PlatformApi): MaybePromise<void>;
  onClose?(platform: PlatformApi): MaybePromise<void>;
}

export type ServiceScope = "singleton" | "request" | "transient";

export interface ServiceReference<T> {
  readonly name?: string;
  readonly scope: ServiceScope;
  readonly factory: ServiceFactory<T>;
}

export interface ServiceOverride<T = unknown> {
  readonly name: string;
  readonly value: T;
}

export interface ServiceResolver {
  get<T>(service: ServiceReference<T>): Promise<T>;
}

export type ServiceFactory<T> = (services: ServiceResolver) => MaybePromise<T>;

export interface ModuleApi extends RouteGroupApi {
  singleton<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  singleton<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  use<T>(port: Port<T>): T;
}

export interface Port<T> {
  readonly id: string;
  readonly version: ContractVersion;
  readonly __type?: T;
}

export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
}

export interface ProviderHealth {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly provider: string;
  readonly detail?: string;
}

export interface ProviderLifecycle {
  connect?(): MaybePromise<void>;
  health?(): MaybePromise<ProviderHealth>;
  close?(): MaybePromise<void>;
}

export interface PortProvider<T> {
  readonly port: Port<T>;
  readonly value: T;
  readonly lifecycle?: ProviderLifecycle;
}

export interface Module {
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly requires?: readonly Port<unknown>[];
  readonly provides?: readonly PortProvider<unknown>[];
  setup(module: ModuleApi): MaybePromise<void>;
  onStart?(module: ModuleApi): MaybePromise<void>;
  onClose?(module: ModuleApi): MaybePromise<void>;
}

export interface HyApplication {
  readonly config: AppConfig;
  fetch(request: Request): MaybePromise<Response>;
  request(input: RequestInfo | URL, init?: RequestInit): MaybePromise<Response>;
  health(): Promise<HealthReport>;
  close(): Promise<void>;
}

export interface HealthReport {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly providers: readonly ProviderHealth[];
}

export interface ApplicationOptions {
  readonly config: AppConfig | AppConfigOptions;
  readonly modules: readonly Module[];
  readonly plugins?: readonly Plugin[];
  readonly overrides?: readonly ServiceOverride[];
  readonly providers?: readonly PortProvider<unknown>[];
}

export const DEFAULT_BODY_LIMIT_BYTES = 10_485_760;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface AppConfig {
  readonly name: string;
  readonly version: string;
  readonly environment: "development" | "test" | "production";
  readonly requestIdHeader: string;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  /** How long `close()` waits for in-flight requests before aborting them. */
  readonly shutdownTimeoutMs?: number;
  readonly openapi: {
    readonly enabled?: boolean;
    readonly title: string;
    readonly description?: string;
    readonly version: string;
    readonly path: string;
  };
}

export interface AppConfigOptions {
  readonly name: string;
  readonly version?: string;
  readonly environment?: AppConfig["environment"];
  readonly requestIdHeader?: string;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly openapi?: {
    readonly enabled?: boolean;
    readonly title?: string;
    readonly description?: string;
    readonly version?: string;
    readonly path?: string;
  };
}

export interface HyApiOptions {
  readonly config: AppConfig;
  readonly modules?: readonly Module[];
  readonly plugins?: readonly Plugin[];
  readonly overrides?: readonly ServiceOverride[];
  readonly providers?: readonly PortProvider<unknown>[];
}

export interface OpenApiInfo {
  title: string;
  description?: string;
  version: string;
}

export interface OpenApiOptions {
  info: OpenApiInfo;
  path: string;
}

export type AnyRouteDefinition = RouteDefinition<
  Schema | undefined,
  Schema | undefined,
  Schema | undefined,
  ResponseSchemas | undefined,
  boolean
>;

export const defineRoute = <
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
  TResponse extends ResponseSchemas | undefined = undefined,
  TBodyRequired extends boolean = true,
>(route: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired>) => route;

export const defineModule = (module: Module): Module => module;

export function defineConfig(options: AppConfigOptions): AppConfig {
  const version = options.version ?? "0.1.0";
  return {
    name: options.name,
    version,
    environment: options.environment ?? "development",
    requestIdHeader: options.requestIdHeader ?? "x-request-id",
    bodyLimitBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    openapi: {
      ...(options.openapi?.enabled === undefined ? {} : { enabled: options.openapi.enabled }),
      title: options.openapi?.title ?? `${options.name} API`,
      ...(options.openapi?.description === undefined
        ? {}
        : { description: options.openapi.description }),
      version: options.openapi?.version ?? version,
      path: options.openapi?.path ?? "/openapi.json",
    },
  };
}

export const definePlugin = (plugin: Plugin): Plugin => plugin;

export const provideValue = <T>(name: string, value: T): ServiceOverride<T> => ({ name, value });

export function definePort<T>(
  id: string,
  version: ContractVersion = { major: 1, minor: 0 },
): Port<T> {
  validateContractVersion(version);
  return { id, version };
}

export const providePort = <T>(
  port: Port<T>,
  value: T,
  lifecycle?: ProviderLifecycle,
): PortProvider<T> => ({
  port,
  value,
  ...(lifecycle ? { lifecycle } : {}),
});

export function isProtectedAuth(
  auth: AuthRequirement | undefined,
): auth is Exclude<AuthRequirement, false> {
  return auth !== undefined && auth !== false;
}

export function extractResponseSchemas(
  route: AnyRouteDefinition,
): Record<number, Schema | undefined> {
  if (route.responses) {
    return route.responses;
  }
  const defaultStatus = route.responseStatus ??
    (route.method === "post" ? 201 : route.method === "delete" ? 204 : 200);
  return { [defaultStatus]: undefined };
}
