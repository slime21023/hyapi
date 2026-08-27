import type { Context, Hono } from "@hono/hono";
import type { Static, TSchema } from "typebox";

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
> {
  params?: TParams;
  query?: TQuery;
  body?: TBody;
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

export interface RequestContext<
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
> {
  readonly request: Request;
  readonly raw: Context;
  readonly requestId: string;
  readonly params: InferSchema<TParams>;
  readonly query: InferSchema<TQuery>;
  readonly body: InferSchema<TBody>;
  readonly headers: Headers;
  identity: Identity | null;
  readonly state: Map<string, unknown>;
  respond<T>(body: T, init?: ResponseInit): ResponseResult<T>;
  noContent(): ResponseResult<undefined>;
}

export interface LifecycleContext {
  readonly request: Request;
  readonly raw: Context;
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
> = (context: RequestContext<TParams, TQuery, TBody>) => MaybePromise<unknown>;

export interface RouteDefinition<
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
  TResponse extends Schema | undefined = undefined,
> {
  method: HttpMethod;
  path: string;
  request?: RouteRequestSchemas<TParams, TQuery, TBody>;
  response?: TResponse;
  responseStatus?: number;
  auth?: AuthRequirement;
  metadata?: RouteMetadata;
  handler(context: RequestContext<TParams, TQuery, TBody>): MaybePromise<unknown>;
}

export interface PluginApi {
  readonly http: Hono;
  addHook(point: "onRequest" | "onResponse" | "onError", hook: LifecycleHook): void;
  route<
    TParams extends Schema | undefined,
    TQuery extends Schema | undefined,
    TBody extends Schema | undefined,
    TResponse extends Schema | undefined,
  >(route: RouteDefinition<TParams, TQuery, TBody, TResponse>): void;
  setAuthProvider(provider: AuthProvider): void;
  decorate<T>(name: string, value: T): void;
  getDecoration<T>(name: string): T | undefined;
}

export interface Plugin<Options = unknown> {
  readonly name: string;
  readonly dependencies?: readonly string[];
  register(app: PluginApi, options: Options): MaybePromise<void>;
}

export interface AppConfig {
  readonly name: string;
  readonly version: string;
  readonly environment: "development" | "test" | "production";
  readonly requestIdHeader: string;
  readonly openapi: {
    readonly title: string;
    readonly description?: string;
    readonly version: string;
    readonly path: string;
  };
}

export interface HyApiOptions {
  readonly config: AppConfig;
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
  Schema | undefined
>;

export const defineRoute = <
  TParams extends Schema | undefined = undefined,
  TQuery extends Schema | undefined = undefined,
  TBody extends Schema | undefined = undefined,
  TResponse extends Schema | undefined = undefined,
>(route: RouteDefinition<TParams, TQuery, TBody, TResponse>) => route;

export function isProtectedAuth(
  auth: AuthRequirement | undefined,
): auth is Exclude<AuthRequirement, false> {
  return auth !== undefined && auth !== false;
}
