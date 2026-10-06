import type { Static, TSchema } from "typebox";
import type { AppConfig, AppConfigOptions } from "./config.ts";
import type { HealthCheck, HealthReport } from "./health.ts";
import type { Port, PortProvider } from "./port.ts";
import type { RequestState } from "./state.ts";

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

/** Authentication required by a route or route group; `false` opts out when inheritance permits it. */
export type AuthRequirement = false | {
  required?: boolean;
  scopes?: readonly string[];
};

/** Immutable principal made available after successful authentication. */
export interface Identity {
  readonly subject: string;
  readonly scopes: readonly string[];
}

/** Authenticates an HTTP request for protected routes. */
export interface AuthProvider {
  authenticate(request: Request): MaybePromise<Identity | null>;
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
  auth?: AuthRequirement;
  metadata?: RouteMetadata;
  handler: RouteHandler<TParams, TQuery, TBody, TBodyRequired>;
}

/** Defaults inherited by routes and nested groups. */
export interface RouteGroupOptions {
  prefix?: string | undefined;
  auth?: AuthRequirement | undefined;
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
  setAuthProvider(provider: AuthProvider): void;
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
export interface ModuleApi extends RouteGroupApi {
  singleton<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  singleton<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  use<T>(port: Port<T>): T;
}

/** Independently composed application unit with explicit dependencies and lifecycle hooks. */
export interface Module {
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly requires?: readonly Port<unknown>[];
  readonly provides?: readonly PortProvider<unknown>[];
  setup(module: ModuleApi): MaybePromise<void>;
  onStart?(module: ModuleApi): MaybePromise<void>;
  onClose?(module: ModuleApi): MaybePromise<void>;
}

/** Ready-to-serve application facade returned by {@link createApplication}. */
export interface HyApplication {
  readonly config: AppConfig;
  fetch(request: Request): MaybePromise<Response>;
  request(input: RequestInfo | URL, init?: RequestInit): MaybePromise<Response>;
  health(): Promise<HealthReport>;
  close(): Promise<void>;
}

/** Inputs used to compose an application before it starts. */
export interface ApplicationOptions {
  readonly config: AppConfig | AppConfigOptions;
  readonly modules: readonly Module[];
  readonly plugins?: readonly Plugin[];
  readonly overrides?: readonly ServiceOverride[];
  readonly providers?: readonly PortProvider<unknown>[];
  readonly healthChecks?: readonly HealthCheck[];
}

export interface HyApiOptions {
  readonly config: AppConfig;
  readonly modules?: readonly Module[];
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
