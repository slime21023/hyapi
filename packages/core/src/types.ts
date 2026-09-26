import type { Static, TSchema } from "typebox";
import type { AppConfig, AppConfigOptions } from "./config.ts";
import type { HealthReport, Port, PortProvider } from "./port.ts";

export type MaybePromise<T> = T | Promise<T>;
export type Schema = TSchema;
export type InferSchema<T extends Schema | undefined> = T extends Schema ? Static<T>
  : unknown;

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "options";

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

export interface RouteMetadata {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: readonly string[];
  /** OpenAPI document IDs; omitted routes use the configured default document. */
  documentIds?: readonly string[];
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
  request?: RouteRequestSchemas<TParams, TQuery, TBody, TBodyRequired>;
  responses?: TResponse;
  responseStatus?: number;
  auth?: AuthRequirement;
  metadata?: RouteMetadata;
  handler: RouteHandler<TParams, TQuery, TBody, TBodyRequired>;
}

export interface RouteGroupOptions {
  prefix?: string | undefined;
  auth?: AuthRequirement | undefined;
  tags?: readonly string[] | undefined;
}

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

export interface ApplicationOptions {
  readonly config: AppConfig | AppConfigOptions;
  readonly modules: readonly Module[];
  readonly plugins?: readonly Plugin[];
  readonly overrides?: readonly ServiceOverride[];
  readonly providers?: readonly PortProvider<unknown>[];
}

export interface HyApiOptions {
  readonly config: AppConfig;
  readonly modules?: readonly Module[];
  readonly plugins?: readonly Plugin[];
  readonly overrides?: readonly ServiceOverride[];
  readonly providers?: readonly PortProvider<unknown>[];
}

export type AnyRouteDefinition = RouteDefinition<
  Schema | undefined,
  Schema | undefined,
  Schema | undefined,
  ResponseSchemas | undefined,
  boolean
>;
