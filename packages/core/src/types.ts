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
  readonly raw: Context;
  readonly requestId: string;
  readonly params: InferSchema<TParams>;
  readonly query: InferSchema<TQuery>;
  readonly body: TBodyRequired extends false ? InferSchema<TBody> | undefined : InferSchema<TBody>;
  readonly headers: Headers;
  identity: Identity | null;
  readonly state: Map<string, unknown>;
  ok<T>(body: T, init?: ResponseInit): ResponseResult<T>;
  created<T>(body: T, init?: ResponseInit): ResponseResult<T>;
  noContent(init?: ResponseInit): ResponseResult<undefined>;
  json<T>(body: T, status?: number, init?: ResponseInit): ResponseResult<T>;
  respond<T>(body: T, init?: ResponseInit): ResponseResult<T>;
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

export interface PluginApi extends RouteGroupApi {
  readonly http: Hono;
  setAuthProvider(provider: AuthProvider): void;
  decorate<T>(name: string, value: T): void;
  getDecoration<T>(name: string): T | undefined;
}

export interface Plugin<Options = unknown> {
  readonly name: string;
  readonly dependencies?: readonly string[];
  register(app: PluginApi, options: Options): MaybePromise<void>;
  onStart?(app: PluginApi): MaybePromise<void>;
  onClose?(app: PluginApi): MaybePromise<void>;
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
