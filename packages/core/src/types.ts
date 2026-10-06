import type { Static, TSchema } from "typebox";
import type { AppConfig, AppConfigOptions } from "./config.ts";
import type { HealthCheck, HealthReport } from "./health.ts";
import type { Port, PortProvider, ProviderLifecycle } from "./port.ts";
import type { RequestState } from "./state.ts";
import type { Guard } from "./guards.ts";

export type MaybePromise<T> = T | Promise<T>;
/** A TypeBox schema used to validate and infer HTTP values. */
export type Schema = TSchema;
export type InferSchema<T extends Schema | undefined> = T extends Schema ? Static<T>
  : unknown;

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "options";

/** Schemas that validate a route's path, query, body, and headers. */
export interface RouteRequestSchemas<
  TParams extends Schema | undefined = Schema | undefined,
  TQuery extends Schema | undefined = Schema | undefined,
  TBody extends Schema | undefined = Schema | undefined,
  TBodyRequired extends boolean = true,
> {
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  bodyRequired?: TBodyRequired;
  headers?: Schema | undefined;
}

/** Descriptive route metadata projected into generated OpenAPI documents. */
export interface RouteMetadata {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: readonly string[];
  /** OpenAPI document IDs; omitted routes use the configured default document. */
  documentIds?: readonly string[];
  deprecated?: boolean;
}

/** Immutable principal established by a guard. */
export interface Identity {
  readonly subject: string;
  readonly scopes: readonly string[];
  /** Verified credential claims, such as token claims; empty when the guard has none. */
  readonly claims: Readonly<Record<string, unknown>>;
}

/** Framework response descriptor returned by a route handler. */
export interface ResponseResult<T = unknown> {
  readonly __hyapiResponse: true;
  readonly body: T;
  readonly init?: ResponseInit;
}

/** Response schemas keyed by HTTP status code. */
export type ResponseSchemas = Record<number, Schema>;

/** Typed request input and request-scoped capabilities supplied to a route handler. */
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
  readonly identity: Identity | null;
  readonly state: RequestState;
  readonly services: ServiceResolver;
  ok<T>(body: T, init?: ResponseInit): ResponseResult<T>;
  created<T>(body: T, init?: ResponseInit): ResponseResult<T>;
  noContent(init?: ResponseInit): ResponseResult<undefined>;
  json<T>(body: T, status?: number, init?: ResponseInit): ResponseResult<T>;
  respond<T>(body: T, init?: ResponseInit): ResponseResult<T>;
}

/** Read-only pipeline snapshot observed by lifecycle hooks. */
export interface LifecycleContext {
  readonly request: Request;
  readonly requestId: string;
  /** Deliberate mutable channel shared by hooks and handlers. */
  readonly state: RequestState;
  readonly route: AnyRouteDefinition | null;
  readonly identity: Identity | null;
  readonly response: Response | null;
  readonly error: unknown | null;
}

/** Work registered for the request, response, or error lifecycle point. */
export type LifecycleHook = (context: LifecycleContext) => MaybePromise<void>;

/** Handles one validated route request and produces its response result. */
export type RouteHandler<
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
  TBodyRequired extends boolean = true,
> = (context: RequestContext<TParams, TQuery, TBody, TBodyRequired>) => MaybePromise<unknown>;

/** Declarative HTTP route, including validation, response, and authorization rules. */
export interface RouteDefinition<
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
  TResponse extends ResponseSchemas | undefined = undefined,
  TBodyRequired extends boolean = true,
> {
  method: HttpMethod;
  path: string;
  request?: RouteRequestSchemas<TParams, TQuery, TBody, TBodyRequired>;
  responses?: TResponse;
  responseStatus?: number;
  /** Guards run after inherited group guards, before the request body is parsed. */
  guards?: readonly Guard[];
  metadata?: RouteMetadata;
  handler: RouteHandler<TParams, TQuery, TBody, TBodyRequired>;
}

/** Defaults inherited by routes and nested groups. */
export interface RouteGroupOptions {
  prefix?: string | undefined;
  /** Guards inherited by every route and nested group; they cannot be removed below. */
  guards?: readonly Guard[] | undefined;
  tags?: readonly string[] | undefined;
}

/** Registers routes and hooks inside a scoped prefix, tag, and authorization context. */
export interface RouteGroupApi {
  addHook(point: "onRequest" | "onResponse" | "onError", hook: LifecycleHook): void;
  route<
    TParams extends Schema | undefined = undefined,
    TQuery extends Schema | undefined = undefined,
    TBody extends Schema | undefined = undefined,
    TResponse extends ResponseSchemas | undefined = undefined,
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

/** Narrow platform capabilities available to plugins. */
export interface PlatformApi {
  addHook(point: "onRequest" | "onResponse" | "onError", hook: LifecycleHook): void;
}

/** Extension that participates in application setup, startup, and shutdown. */
export interface Plugin {
  readonly name: string;
  readonly dependencies?: readonly string[];
  setup(platform: PlatformApi): MaybePromise<void>;
  onStart?(platform: PlatformApi): MaybePromise<void>;
  onClose?(platform: PlatformApi): MaybePromise<void>;
}

export type ServiceScope = "singleton" | "request" | "transient";

/** Describes a service and the lifetime used to resolve it. */
export interface ServiceReference<T> {
  readonly name?: string;
  readonly scope: ServiceScope;
  readonly factory: ServiceFactory<T>;
}

/** Application-level replacement for a named service. */
export type ServiceOverride<T = unknown> = {
  readonly name: string;
  readonly value: T;
} | {
  readonly name: string;
  readonly factory: ServiceFactory<T>;
};

export interface ServiceResolver {
  get<T>(service: ServiceReference<T>): Promise<T>;
}

export type ServiceFactory<T> = (services: ServiceResolver) => MaybePromise<T>;

/** Capabilities supplied while a module declares routes, services, and Port dependencies. */
export interface ModuleApi<TConfig = unknown> extends RouteGroupApi {
  /** The module's validated, defaulted, and frozen configuration. */
  readonly config: TConfig;
  singleton<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  singleton<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  use<T>(port: Port<T>): T;
  /** Implements a Port declared in `provides`; the factory resolves after this module's setup. */
  provide<T>(port: Port<T>, factory: ServiceFactory<T>, lifecycle?: ProviderLifecycle): void;
  /** Registers a readiness check; names are unique across the application. */
  healthCheck(check: HealthCheck): void;
  /** Runs readiness checks; reports unhealthy unless the application is running. */
  health(): Promise<HealthReport>;
  /** Reports liveness without running checks; healthy while running or draining. */
  liveness(): HealthReport;
}

/** Independently composed application unit with explicit dependencies and lifecycle hooks. */
export interface Module<TConfig extends Schema | undefined = Schema | undefined> {
  readonly name: string;
  /** Schema for this module's entry in {@link ApplicationOptions.moduleConfig}. */
  readonly config?: TConfig;
  readonly dependencies?: readonly string[];
  readonly requires?: readonly Port<unknown>[];
  /** Ports this module implements with {@link ModuleApi.provide} during setup. */
  readonly provides?: readonly Port<unknown>[];
  setup(module: ModuleApi<InferSchema<TConfig>>): MaybePromise<void>;
  onStart?(module: ModuleApi<InferSchema<TConfig>>): MaybePromise<void>;
  onClose?(module: ModuleApi<InferSchema<TConfig>>): MaybePromise<void>;
}

/** Ready-to-serve application facade returned by {@link createApplication}. */
export interface HyApplication {
  readonly config: AppConfig;
  fetch(request: Request): MaybePromise<Response>;
  request(input: RequestInfo | URL, init?: RequestInit): MaybePromise<Response>;
  /** Readiness: runs health checks while running; unhealthy while draining or closed. */
  health(): Promise<HealthReport>;
  /** Liveness: healthy while running or draining; does not run health checks. */
  liveness(): HealthReport;
  close(): Promise<void>;
}

/** Inputs used to compose an application before it starts. */
export interface ApplicationOptions {
  readonly config: AppConfig | AppConfigOptions;
  readonly modules: readonly Module[];
  /** Configuration values keyed by module name, validated against each module's schema. */
  readonly moduleConfig?: Readonly<Record<string, unknown>>;
  readonly plugins?: readonly Plugin[];
  readonly overrides?: readonly ServiceOverride[];
  readonly providers?: readonly PortProvider<unknown>[];
  readonly healthChecks?: readonly HealthCheck[];
}

export interface HyApiOptions {
  readonly config: AppConfig;
  readonly modules?: readonly Module[];
  readonly moduleConfig?: Readonly<Record<string, unknown>>;
  readonly plugins?: readonly Plugin[];
  readonly overrides?: readonly ServiceOverride[];
  readonly providers?: readonly PortProvider<unknown>[];
  readonly healthChecks?: readonly HealthCheck[];
}

/** Non-generic route shape used when processing routes as a collection. */
export type AnyRouteDefinition = RouteDefinition<
  Schema | undefined,
  Schema | undefined,
  Schema | undefined,
  ResponseSchemas | undefined,
  boolean
>;
