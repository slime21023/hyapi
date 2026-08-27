import { type Context, Hono } from "@hono/hono";
import {
  type AnyRouteDefinition,
  type AppConfig,
  type AuthProvider,
  type HyApiOptions,
  type Identity,
  isProtectedAuth,
  type LifecycleContext,
  type LifecycleHook,
  type Plugin,
  type PluginApi,
  type RequestContext,
  type ResponseResult,
  type RouteDefinition,
  type Schema,
} from "./types.ts";
import {
  AppError,
  ConfigurationError,
  ForbiddenError,
  NotFoundError,
  toProblemDetails,
  UnauthorizedError,
} from "./errors.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { headerObject, jsonBody, queryObject, SchemaValidator } from "./validation.ts";

interface RequestRuntime {
  requestId: string;
  state: Map<string, unknown>;
  route: AnyRouteDefinition | null;
  identity: Identity | null;
  lifecycle: LifecycleContext;
}

const RESPONSE_RESULT = "__hyapiResponse" as const;

function isResponseResult(value: unknown): value is ResponseResult {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)[RESPONSE_RESULT] === true;
}

export class HyApiApp implements PluginApi {
  readonly http: Hono;
  readonly config: AppConfig;
  readonly validator = new SchemaValidator();

  private readonly routes: AnyRouteDefinition[] = [];
  private readonly plugins = new Set<string>();
  private readonly decorations = new Map<string, unknown>();
  private readonly hooks: Record<"onRequest" | "onResponse" | "onError", LifecycleHook[]> = {
    onRequest: [],
    onResponse: [],
    onError: [],
  };
  private readonly runtimeByRequest = new WeakMap<Request, RequestRuntime>();
  private authProvider: AuthProvider | null = null;
  private initialized = false;

  constructor(options: HyApiOptions) {
    this.config = options.config;
    this.http = new Hono();
    this.mountCoreMiddleware();
    this.http.get(this.config.openapi.path, (context) => {
      const document = buildOpenApiDocument(this.routes, this.validator, {
        info: {
          title: this.config.openapi.title,
          ...(this.config.openapi.description
            ? { description: this.config.openapi.description }
            : {}),
          version: this.config.openapi.version,
        },
        path: this.config.openapi.path,
      });
      return context.json(document);
    });
    this.http.notFound((context) => {
      const requestId = context.req.raw.headers.get(this.config.requestIdHeader) ??
        crypto.randomUUID();
      return this.errorResponse(new NotFoundError(), context.req.raw, requestId);
    });
    this.http.onError(async (error, context) => {
      const runtime = this.runtimeByRequest.get(context.req.raw);
      if (runtime) {
        runtime.lifecycle.error = error;
        await this.runHooks("onError", runtime.lifecycle, true);
      }
      const requestId = runtime?.requestId ??
        context.req.raw.headers.get(this.config.requestIdHeader) ?? crypto.randomUUID();
      return this.errorResponse(error, context.req.raw, requestId);
    });
  }

  async register<Options>(plugin: Plugin<Options>, options: Options): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new ConfigurationError(`Plugin '${plugin.name}' is already registered.`);
    }
    for (const dependency of plugin.dependencies ?? []) {
      if (!this.plugins.has(dependency)) {
        throw new ConfigurationError(
          `Plugin '${plugin.name}' requires '${dependency}' to be registered first.`,
        );
      }
    }
    await plugin.register(this, options);
    this.plugins.add(plugin.name);
  }

  addHook(point: "onRequest" | "onResponse" | "onError", hook: LifecycleHook): void {
    this.hooks[point].push(hook);
  }

  route(route: AnyRouteDefinition): void;
  route<
    TParams extends Schema | undefined,
    TQuery extends Schema | undefined,
    TBody extends Schema | undefined,
    TResponse extends Schema | undefined,
  >(route: RouteDefinition<TParams, TQuery, TBody, TResponse>): void {
    const registeredRoute = route as unknown as AnyRouteDefinition;
    if (
      this.routes.some((registered) =>
        registered.method === registeredRoute.method && registered.path === registeredRoute.path
      )
    ) {
      throw new ConfigurationError(
        `Route '${registeredRoute.method.toUpperCase()} ${registeredRoute.path}' is already registered.`,
      );
    }
    this.routes.push(registeredRoute);
    const handler = (context: Context) => this.handleRoute(context, registeredRoute);
    const honoPath = toHonoPath(registeredRoute.path);
    this.http.on(registeredRoute.method.toUpperCase(), honoPath, handler);
  }

  setAuthProvider(provider: AuthProvider): void {
    if (this.authProvider) throw new ConfigurationError("An auth provider is already registered.");
    this.authProvider = provider;
  }

  decorate<T>(name: string, value: T): void {
    if (this.decorations.has(name)) {
      throw new ConfigurationError(`Decoration '${name}' already exists.`);
    }
    this.decorations.set(name, value);
  }

  getDecoration<T>(name: string): T | undefined {
    return this.decorations.get(name) as T | undefined;
  }

  async ready(): Promise<void> {
    if (this.initialized) return;
    const hasProtectedRoutes = this.routes.some((route) => isProtectedAuth(route.auth));
    if (hasProtectedRoutes && !this.authProvider) {
      throw new ConfigurationError("Protected routes require an auth provider.");
    }
    this.initialized = true;
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.http.fetch(request);
  }

  request(input: RequestInfo | URL, init?: RequestInit): Response | Promise<Response> {
    return this.http.request(input, init);
  }

  private mountCoreMiddleware(): void {
    this.http.use("*", async (context, next) => {
      const request = context.req.raw;
      const requestId = request.headers.get(this.config.requestIdHeader) ?? crypto.randomUUID();
      const state = new Map<string, unknown>();
      const runtime: RequestRuntime = {
        requestId,
        state,
        route: null,
        identity: null,
        lifecycle: {
          request,
          raw: context,
          requestId,
          state,
          route: null,
          identity: null,
          response: null,
          error: null,
        },
      };
      this.runtimeByRequest.set(request, runtime);

      let response: Response | null = null;
      try {
        await this.runHooks("onRequest", runtime.lifecycle);
        await next();
        response = context.res;
        runtime.lifecycle.response = response;
        await this.runHooks("onResponse", runtime.lifecycle);
      } catch (error) {
        runtime.lifecycle.error = error;
        await this.runHooks("onError", runtime.lifecycle, true);
        response = this.errorResponse(error, request, requestId);
      } finally {
        this.runtimeByRequest.delete(request);
      }

      if (response) {
        response.headers.set(this.config.requestIdHeader, requestId);
        context.res = response;
      }
    });
  }

  private async handleRoute(context: Context, route: AnyRouteDefinition): Promise<Response> {
    const request = context.req.raw;
    const runtime = this.runtimeByRequest.get(request);
    if (!runtime) {
      throw new AppError(
        500,
        "REQUEST_CONTEXT_MISSING",
        "Request context is unavailable.",
        undefined,
        false,
      );
    }
    runtime.route = route;
    runtime.lifecycle.route = route;

    const identity = await this.authenticate(request, route);
    runtime.identity = identity;
    runtime.lifecycle.identity = identity;

    const requestSchemas = route.request;
    const params = requestSchemas?.params
      ? this.validator.validate(requestSchemas.params, context.req.param(), "params")
      : context.req.param();
    const query = requestSchemas?.query
      ? this.validator.validate(requestSchemas.query, queryObject(request), "query")
      : queryObject(request);
    const rawBody = requestSchemas?.body ? await jsonBody(request) : undefined;
    const body = requestSchemas?.body && rawBody !== undefined
      ? this.validator.validate(requestSchemas.body, rawBody, "body")
      : rawBody;
    const headers = requestSchemas?.headers
      ? this.validator.validate(requestSchemas.headers, headerObject(request.headers), "headers")
      : headerObject(request.headers);

    const routeContext: RequestContext = {
      request,
      raw: context,
      requestId: runtime.requestId,
      params,
      query,
      body,
      headers: new Headers(headers as Record<string, string>),
      identity,
      state: runtime.state,
      respond: <T>(value: T, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        ...(init ? { init } : {}),
      }),
      noContent: (): ResponseResult<undefined> => ({
        [RESPONSE_RESULT]: true,
        body: undefined,
        init: { status: 204 },
      }),
    };
    const result = await route.handler(routeContext);
    return this.toResponse(result, route);
  }

  private async authenticate(
    request: Request,
    route: AnyRouteDefinition,
  ): Promise<Identity | null> {
    if (!isProtectedAuth(route.auth)) return null;
    if (!this.authProvider) throw new ConfigurationError("No auth provider is configured.");
    const identity = await this.authProvider.authenticate(request);
    const required = route.auth.required !== false;
    if (!identity && required) throw new UnauthorizedError();
    if (identity && route.auth.scopes) {
      const hasAllScopes = route.auth.scopes.every((scope) => identity.scopes.includes(scope));
      if (!hasAllScopes) throw new ForbiddenError();
    }
    return identity;
  }

  private toResponse(result: unknown, route: AnyRouteDefinition): Response {
    if (result instanceof Response) return result;
    let body = result;
    let init: ResponseInit = { status: route.responseStatus ?? 200 };
    if (isResponseResult(result)) {
      body = result.body;
      init = result.init ?? init;
    }
    if (route.response && body !== undefined) {
      body = this.validator.validate(route.response as Schema, body, "response");
    }
    if (body === undefined) return new Response(null, { ...init, status: init.status ?? 204 });
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=UTF-8");
    }
    return new Response(JSON.stringify(body), { ...init, headers });
  }

  private errorResponse(error: unknown, request: Request, requestId: string): Response {
    const problem = toProblemDetails(error, request, requestId);
    const headers = new Headers({ "content-type": "application/problem+json" });
    if (problem.status === 401) headers.set("www-authenticate", "Bearer");
    return new Response(JSON.stringify(problem), { status: problem.status, headers });
  }

  private async runHooks(
    point: "onRequest" | "onResponse" | "onError",
    lifecycle: LifecycleContext,
    swallowErrors = false,
  ): Promise<void> {
    for (const hook of this.hooks[point]) {
      try {
        await hook(lifecycle);
      } catch (error) {
        if (!swallowErrors) throw error;
      }
    }
  }
}

function toHonoPath(path: string): string {
  return path.replace(/\{([^}/]+)\}/g, ":$1");
}

export function createApp(options: HyApiOptions): HyApiApp {
  return new HyApiApp(options);
}
