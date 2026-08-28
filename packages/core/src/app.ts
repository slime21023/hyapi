import { type Context, Hono } from "@hono/hono";
import {
  type AnyRouteDefinition,
  type AppConfig,
  type AuthProvider,
  extractResponseSchemas,
  type HyApiOptions,
  type Identity,
  isProtectedAuth,
  type LifecycleContext,
  type LifecycleHook,
  type Plugin,
  type PluginApi,
  type RequestContext,
  type ResponseResult,
  type ResponseSchemas,
  type RouteDefinition,
  type RouteGroupApi,
  type RouteGroupOptions,
  type Schema,
} from "./types.ts";
import {
  AppError,
  ConfigurationError,
  ForbiddenError,
  NotFoundError,
  ResponseContractError,
  toProblemDetails,
  UnauthorizedError,
  ValidationError,
} from "./errors.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { headerObject, parseRequestBody, queryObject, SchemaValidator } from "./validation.ts";

interface RequestRuntime {
  requestId: string;
  state: Map<string, unknown>;
  bodyRequest: Request;
  route: AnyRouteDefinition | null;
  identity: Identity | null;
  lifecycle: LifecycleContext;
}

interface PluginRegistration {
  plugin: Plugin<unknown>;
  options: unknown;
  registered: boolean;
}

type AppLifecycleState = "configuring" | "starting" | "ready" | "failed" | "closing" | "closed";

const RESPONSE_RESULT = "__hyapiResponse" as const;

function isResponseResult(value: unknown): value is ResponseResult {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)[RESPONSE_RESULT] === true;
}

function joinPaths(base: string | undefined, path: string): string {
  const cleanBase = (base ?? "").trim().replace(/\/+$/, "");
  const cleanPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleanBase && !cleanPath) return "/";
  if (!cleanBase) return `/${cleanPath}`;
  if (!cleanPath) return cleanBase.startsWith("/") ? cleanBase : `/${cleanBase}`;
  const formattedBase = cleanBase.startsWith("/") ? cleanBase : `/${cleanBase}`;
  return `${formattedBase}/${cleanPath}`;
}

function topologicalSort(plugins: PluginRegistration[]): PluginRegistration[] {
  const byName = new Map<string, PluginRegistration>();
  for (const item of plugins) {
    byName.set(item.plugin.name, item);
  }

  for (const item of plugins) {
    for (const dep of item.plugin.dependencies ?? []) {
      if (!byName.has(dep)) {
        throw new ConfigurationError(
          `Plugin '${item.plugin.name}' requires '${dep}' to be registered.`,
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: PluginRegistration[] = [];

  function visit(name: string) {
    if (visiting.has(name)) {
      throw new ConfigurationError(`Circular dependency detected involving plugin '${name}'.`);
    }
    if (!visited.has(name)) {
      visiting.add(name);
      const item = byName.get(name)!;
      for (const dep of item.plugin.dependencies ?? []) {
        visit(dep);
      }
      visiting.delete(name);
      visited.add(name);
      sorted.push(item);
    }
  }

  for (const item of plugins) {
    if (!visited.has(item.plugin.name)) {
      visit(item.plugin.name);
    }
  }

  return sorted;
}

function normalizeGroupArgs(
  prefixOrOptions: string | RouteGroupOptions,
  optionsOrFn?: RouteGroupOptions | ((group: RouteGroupApi) => void),
  maybeFn?: (group: RouteGroupApi) => void,
): { options: RouteGroupOptions; fn: (group: RouteGroupApi) => void } {
  if (typeof prefixOrOptions === "string") {
    if (typeof optionsOrFn === "function") {
      return { options: { prefix: prefixOrOptions }, fn: optionsOrFn };
    }
    return { options: { ...optionsOrFn, prefix: prefixOrOptions }, fn: maybeFn! };
  }
  return { options: prefixOrOptions, fn: optionsOrFn as (group: RouteGroupApi) => void };
}

export class RouterGroup implements RouteGroupApi {
  private readonly hooks: Record<"onRequest" | "onResponse" | "onError", LifecycleHook[]>;

  constructor(
    private readonly app: HyApiApp,
    private readonly options: RouteGroupOptions = {},
    parentHooks?: Record<"onRequest" | "onResponse" | "onError", LifecycleHook[]>,
  ) {
    this.hooks = {
      onRequest: parentHooks ? [...parentHooks.onRequest] : [],
      onResponse: parentHooks ? [...parentHooks.onResponse] : [],
      onError: parentHooks ? [...parentHooks.onError] : [],
    };
  }

  addHook(point: "onRequest" | "onResponse" | "onError", hook: LifecycleHook): void {
    this.hooks[point].push(hook);
  }

  route<
    TParams extends Schema | undefined,
    TQuery extends Schema | undefined,
    TBody extends Schema | undefined,
    TResponse extends ResponseSchemas | undefined,
    TBodyRequired extends boolean = true,
  >(route: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired>): void {
    const fullPath = joinPaths(this.options.prefix, route.path);
    const mergedTags = [
      ...(this.options.tags ?? []),
      ...(route.metadata?.tags ?? []),
    ];
    const resolvedAuth = route.auth !== undefined ? route.auth : this.options.auth;

    const mergedRoute: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired> = {
      ...route,
      path: fullPath,
      ...(mergedTags.length > 0
        ? {
          metadata: {
            ...route.metadata,
            tags: mergedTags,
          },
        }
        : {}),
      ...(resolvedAuth !== undefined ? { auth: resolvedAuth } : {}),
    };

    this.app.route(mergedRoute as unknown as AnyRouteDefinition, {
      onRequest: [...this.hooks.onRequest],
      onResponse: [...this.hooks.onResponse],
      onError: [...this.hooks.onError],
    });
  }

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
  group(
    prefixOrOptions: string | RouteGroupOptions,
    optionsOrFn?: RouteGroupOptions | ((group: RouteGroupApi) => void),
    maybeFn?: (group: RouteGroupApi) => void,
  ): void {
    const { options: childOpts, fn } = normalizeGroupArgs(prefixOrOptions, optionsOrFn, maybeFn);
    const mergedPrefix = joinPaths(this.options.prefix, childOpts.prefix ?? "");
    const mergedTags = [
      ...(this.options.tags ?? []),
      ...(childOpts.tags ?? []),
    ];
    const mergedAuth = childOpts.auth !== undefined ? childOpts.auth : this.options.auth;

    const newOpts: RouteGroupOptions = {};
    if (mergedPrefix) newOpts.prefix = mergedPrefix;
    if (mergedTags.length > 0) newOpts.tags = mergedTags;
    if (mergedAuth !== undefined) newOpts.auth = mergedAuth;

    const childGroup = new RouterGroup(this.app, newOpts, this.hooks);
    fn(childGroup);
  }
}

export class HyApiApp implements PluginApi {
  readonly http: Hono;
  readonly config: AppConfig;
  readonly validator = new SchemaValidator();

  private readonly routes: AnyRouteDefinition[] = [];
  private readonly pluginRegistrations: PluginRegistration[] = [];
  private sortedPlugins: PluginRegistration[] = [];
  private readonly decorations = new Map<string, unknown>();
  private readonly hooks: Record<"onRequest" | "onResponse" | "onError", LifecycleHook[]> = {
    onRequest: [],
    onResponse: [],
    onError: [],
  };
  private readonly routeScopedHooks = new WeakMap<
    AnyRouteDefinition,
    Record<"onRequest" | "onResponse" | "onError", LifecycleHook[]>
  >();
  private readonly runtimeByRequest = new WeakMap<Request, RequestRuntime>();
  private authProvider: AuthProvider | null = null;
  private lifecycleState: AppLifecycleState = "configuring";
  private readyPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

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
        if (runtime.route) {
          const scoped = this.routeScopedHooks.get(runtime.route);
          if (scoped?.onError) {
            await this.runHookList(scoped.onError, runtime.lifecycle, true);
          }
        }
        await this.runHooks("onError", runtime.lifecycle, true);
      }
      const requestId = runtime?.requestId ??
        context.req.raw.headers.get(this.config.requestIdHeader) ?? crypto.randomUUID();
      return this.errorResponse(error, context.req.raw, requestId);
    });
  }

  async register<Options>(plugin: Plugin<Options>, options: Options): Promise<void> {
    if (this.lifecycleState !== "configuring") {
      throw new ConfigurationError("Plugins must be registered before the application is ready.");
    }
    if (this.pluginRegistrations.some((reg) => reg.plugin.name === plugin.name)) {
      throw new ConfigurationError(`Plugin '${plugin.name}' is already registered.`);
    }
    this.pluginRegistrations.push({
      plugin: plugin as unknown as Plugin<unknown>,
      options,
      registered: false,
    });
  }

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
  group(
    prefixOrOptions: string | RouteGroupOptions,
    optionsOrFn?: RouteGroupOptions | ((group: RouteGroupApi) => void),
    maybeFn?: (group: RouteGroupApi) => void,
  ): void {
    const rootGroup = new RouterGroup(this, {});
    const { options, fn } = normalizeGroupArgs(prefixOrOptions, optionsOrFn, maybeFn);
    rootGroup.group(options, fn);
  }

  addHook(point: "onRequest" | "onResponse" | "onError", hook: LifecycleHook): void {
    this.hooks[point].push(hook);
  }

  route(
    route: AnyRouteDefinition,
    scopedHooks?: Record<"onRequest" | "onResponse" | "onError", LifecycleHook[]>,
  ): void;
  route<
    TParams extends Schema | undefined,
    TQuery extends Schema | undefined,
    TBody extends Schema | undefined,
    TResponse extends ResponseSchemas | undefined,
    TBodyRequired extends boolean = true,
  >(
    route: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired>,
    scopedHooks?: Record<"onRequest" | "onResponse" | "onError", LifecycleHook[]>,
  ): void {
    const registeredRoute = route as unknown as AnyRouteDefinition;
    if (registeredRoute.request?.bodyRequired !== undefined && !registeredRoute.request.body) {
      throw new ConfigurationError("request.bodyRequired requires a request.body schema.");
    }
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
    if (scopedHooks) {
      this.routeScopedHooks.set(registeredRoute, scopedHooks);
    }
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
    if (this.lifecycleState === "ready") return;
    if (this.readyPromise) return this.readyPromise;
    if (this.lifecycleState !== "configuring") {
      throw new ConfigurationError("The application cannot be initialized in its current state.");
    }

    this.lifecycleState = "starting";
    this.readyPromise = this.initialize();
    try {
      await this.readyPromise;
      this.lifecycleState = "ready";
    } catch (error) {
      this.lifecycleState = "failed";
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.lifecycleState === "closed") return;
    if (this.closePromise) return this.closePromise;

    this.closePromise = this.closeAfterInitialization();
    return this.closePromise;
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
        bodyRequest: request.clone(),
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
        if (runtime.route) {
          const scoped = this.routeScopedHooks.get(runtime.route);
          if (scoped?.onError) {
            await this.runHookList(scoped.onError, runtime.lifecycle, true);
          }
        }
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

    const scoped = this.routeScopedHooks.get(route);
    if (scoped?.onRequest) {
      await this.runHookList(scoped.onRequest, runtime.lifecycle);
    }

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
    const rawBody = requestSchemas?.body && request.method !== "GET" && request.method !== "HEAD"
      ? await parseRequestBody(runtime.bodyRequest)
      : undefined;
    if (requestSchemas?.body && rawBody === undefined && requestSchemas.bodyRequired !== false) {
      throw new ValidationError("body", [{
        keyword: "required",
        instancePath: "",
        schemaPath: "#",
        params: {},
        message: "request body is required",
      }]);
    }
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
      ok: <T>(value: T, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        init: { ...init, status: init?.status ?? 200 },
      }),
      created: <T>(value: T, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        init: { ...init, status: init?.status ?? 201 },
      }),
      noContent: (init?: ResponseInit): ResponseResult<undefined> => ({
        [RESPONSE_RESULT]: true,
        body: undefined,
        init: { ...init, status: 204 },
      }),
      json: <T>(value: T, status = 200, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        init: { ...init, status: init?.status ?? status },
      }),
      respond: <T>(value: T, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        ...(init ? { init } : {}),
      }),
    };
    const result = await route.handler(routeContext);
    const response = this.toResponse(result, route);
    runtime.lifecycle.response = response;

    if (scoped?.onResponse) {
      await this.runHookList(scoped.onResponse, runtime.lifecycle);
    }
    return response;
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
    const defaultStatus = route.responseStatus ??
      (route.method === "post" ? 201 : route.method === "delete" ? 204 : 200);
    let init: ResponseInit = { status: defaultStatus };
    if (isResponseResult(result)) {
      body = result.body;
      init = result.init ?? init;
    }
    const status = init.status ?? defaultStatus;

    const responseSchemas = extractResponseSchemas(route);
    const declaredResponses = route.responses;
    const hasResponseContract = declaredResponses !== undefined;
    if (declaredResponses && !Object.hasOwn(declaredResponses, status)) {
      throw new ResponseContractError(
        `Response status ${status} is not declared for '${route.method.toUpperCase()} ${route.path}'.`,
        { status, declaredStatuses: Object.keys(declaredResponses).map(Number) },
      );
    }
    if (status === 204 && body !== undefined) {
      throw new ResponseContractError("A 204 response must not include a response body.", {
        status,
      });
    }
    if (hasResponseContract && status !== 204 && body === undefined) {
      throw new ResponseContractError(
        `Response status ${status} requires a response body for '${route.method.toUpperCase()} ${route.path}'.`,
        { status },
      );
    }
    const schemaToValidate = responseSchemas[status];
    if (schemaToValidate && body !== undefined) {
      body = this.validator.validate(schemaToValidate, body, "response");
    }

    if (body === undefined || status === 204) {
      return new Response(null, { ...init, status: 204 });
    }
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=UTF-8");
    }
    return new Response(JSON.stringify(body), { ...init, status, headers });
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
    await this.runHookList(this.hooks[point], lifecycle, swallowErrors);
  }

  private async runHookList(
    hooks: readonly LifecycleHook[],
    lifecycle: LifecycleContext,
    swallowErrors = false,
  ): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook(lifecycle);
      } catch (error) {
        if (!swallowErrors) throw error;
      }
    }
  }

  private async initialize(): Promise<void> {
    this.sortedPlugins = topologicalSort(this.pluginRegistrations);
    for (const item of this.sortedPlugins) {
      if (!item.registered) {
        await item.plugin.register(this, item.options);
        item.registered = true;
      }
    }
    for (const item of this.sortedPlugins) {
      if (item.plugin.onStart) {
        await item.plugin.onStart(this);
      }
    }

    const hasProtectedRoutes = this.routes.some((route) => isProtectedAuth(route.auth));
    if (hasProtectedRoutes && !this.authProvider) {
      throw new ConfigurationError("Protected routes require an auth provider.");
    }
  }

  private async closeAfterInitialization(): Promise<void> {
    let initializationError: unknown;
    let hasInitializationError = false;
    if (this.readyPromise) {
      try {
        await this.readyPromise;
      } catch (error) {
        initializationError = error;
        hasInitializationError = true;
      }
    }

    this.lifecycleState = "closing";
    let closeError: unknown;
    let hasCloseError = false;
    for (const item of [...this.sortedPlugins].reverse()) {
      if (!item.registered || !item.plugin.onClose) continue;
      try {
        await item.plugin.onClose(this);
      } catch (error) {
        if (!hasCloseError) {
          closeError = error;
          hasCloseError = true;
        }
      }
    }
    this.lifecycleState = "closed";

    if (hasInitializationError) throw initializationError;
    if (hasCloseError) throw closeError;
  }
}

function toHonoPath(path: string): string {
  return path.replace(/\{([^}/]+)\}/g, ":$1");
}

export function createApp(options: HyApiOptions): HyApiApp {
  return new HyApiApp(options);
}
