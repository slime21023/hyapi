import { type Context, Hono } from "@hono/hono";
import {
  type AnyRouteDefinition,
  type AppConfig,
  type AppConfigOptions,
  type ApplicationOptions,
  type AuthProvider,
  extractResponseSchemas,
  type HealthReport,
  type HyApiOptions,
  type HyApplication,
  type Identity,
  isProtectedAuth,
  type LifecycleContext,
  type LifecycleHook,
  type MaybePromise,
  type Module,
  type ModuleApi,
  type Plugin,
  type Port,
  type PortProvider,
  type ProviderHealth,
  type RequestContext,
  type ResponseResult,
  type ResponseSchemas,
  type RouteDefinition,
  type RouteGroupApi,
  type RouteGroupOptions,
  type Schema,
  type ServiceFactory,
  type ServiceOverride,
  type ServiceReference,
  type ServiceResolver,
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
import { formatContractVersion, isCompatibleContractVersion } from "./version.ts";

interface DependencyNode {
  readonly name: string;
  readonly dependencies?: readonly string[];
}

interface RequestRuntime {
  requestId: string;
  deadline?: number;
  state: Map<string, unknown>;
  route: AnyRouteDefinition | null;
  identity: Identity | null;
  lifecycle: LifecycleContext;
  services: Map<ServiceReference<unknown>, Promise<unknown>>;
  cleanups: unknown[];
}

type AppLifecycleState = "configuring" | "starting" | "ready" | "failed" | "closing" | "closed";

const RESPONSE_RESULT = "__hyapiResponse" as const;

function isResponseResult(value: unknown): value is ResponseResult {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)[RESPONSE_RESULT] === true;
}

function appendErrors(target: unknown[], source: unknown): void {
  if (source instanceof AggregateError) target.push(...source.errors);
  else target.push(source);
}

function createAggregateError(
  errors: readonly unknown[],
  message = "Application shutdown failed.",
): AggregateError {
  return new AggregateError([...errors], message);
}

function flattenError(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
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

function sortByDependencies<T extends DependencyNode>(
  items: readonly T[],
  options: {
    getDependencies?: (item: T) => readonly string[] | undefined;
    readonly getDuplicateMessage: (name: string) => string;
    readonly getMissingDependencyMessage: (dependent: string, dependency: string) => string;
    readonly getCycleMessage: (cycle: readonly string[]) => string;
  },
): T[] {
  const byName = new Map<string, T>();
  for (const item of items) {
    if (byName.has(item.name)) {
      throw new ConfigurationError(options.getDuplicateMessage(item.name));
    }
    byName.set(item.name, item);
  }

  for (const item of items) {
    for (const dep of item.dependencies ?? []) {
      if (!byName.has(dep)) {
        throw new ConfigurationError(options.getMissingDependencyMessage(item.name, dep));
      }
    }
  }

  const visited = new Set<string>();
  const visiting: string[] = [];
  const sorted: T[] = [];

  const visit = (name: string, dependent?: string): void => {
    if (visiting.includes(name)) {
      throw new ConfigurationError(options.getCycleMessage([...visiting, name]));
    }
    if (visited.has(name)) return;

    const item = byName.get(name);
    if (!item) {
      throw new ConfigurationError(options.getMissingDependencyMessage(dependent ?? name, name));
    }
    visiting.push(name);
    for (const dep of options.getDependencies?.(item) ?? item.dependencies ?? []) {
      visit(dep, item.name);
    }
    visiting.pop();
    visited.add(name);
    sorted.push(item);
  };

  for (const item of items) {
    visit(item.name);
  }

  return sorted;
}

function sortModules(modules: readonly Module[]): Module[] {
  return sortByDependencies(modules, {
    getDependencies: (module) => module.dependencies,
    getDuplicateMessage: (name) => `Module '${name}' is already registered.`,
    getMissingDependencyMessage: (dependent, dependency) =>
      `Module '${dependent}' requires '${dependency}' to be registered.`,
    getCycleMessage: (cycle) => `Circular module dependency detected: ${cycle.join(" -> ")}.`,
  });
}

function sortPlugins(plugins: readonly Plugin[]): Plugin[] {
  return sortByDependencies(plugins, {
    getDuplicateMessage: (name) => `Plugin '${name}' is already registered.`,
    getMissingDependencyMessage: (dependent, dependency) =>
      `Plugin '${dependent}' requires '${dependency}' to be registered.`,
    getCycleMessage: (cycle) => `Circular plugin dependency detected: ${cycle.join(" -> ")}.`,
  });
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
    protected readonly app: HyApiApp,
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

class ModuleContext extends RouterGroup implements ModuleApi {
  singleton<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  singleton<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  singleton<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.app.singletonService(nameOrFactory, maybeFactory);
  }

  request<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.app.requestService(nameOrFactory, maybeFactory);
  }

  transient<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.app.transientService(nameOrFactory, maybeFactory);
  }

  use<T>(port: Port<T>): T {
    return this.app.usePort(port);
  }
}

export class HyApiApp {
  readonly http: Hono;
  readonly config: AppConfig;
  readonly validator = new SchemaValidator();

  private readonly routes: AnyRouteDefinition[] = [];
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
  private readonly singletonServices = new Map<ServiceReference<unknown>, Promise<unknown>>();
  private readonly singletonCleanups: unknown[] = [];
  private readonly serviceOverrides = new Map<string, unknown>();
  private readonly portProviders = new Map<string, PortProvider<unknown>>();
  private providersConnected = false;
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

  setOverrides(overrides: readonly ServiceOverride[]): void {
    for (const override of overrides) {
      if (this.serviceOverrides.has(override.name)) {
        throw new ConfigurationError(`Service override '${override.name}' is already registered.`);
      }
      this.serviceOverrides.set(override.name, override.value);
    }
  }

  setPortProviders(providers: readonly PortProvider<unknown>[]): void {
    for (const provider of providers) {
      const existing = this.portProviders.get(provider.port.id);
      if (existing) {
        throw new ConfigurationError(`Port '${provider.port.id}' is already provided.`);
      }
      this.portProviders.set(provider.port.id, provider);
    }
  }

  usePort<T>(port: Port<T>): T {
    const provider = this.portProviders.get(port.id);
    if (!provider) {
      throw new ConfigurationError(`Port '${port.id}' is required but no provider is registered.`);
    }
    if (!isCompatibleContractVersion(port.version, provider.port.version)) {
      throw new ConfigurationError(
        `Port '${port.id}' requires version ${
          formatContractVersion(port.version)
        }, but provider has version ${formatContractVersion(provider.port.version)}.`,
      );
    }
    return provider.value as T;
  }

  singletonService<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  singletonService<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  singletonService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T>;
  singletonService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.serviceReference("singleton", nameOrFactory, maybeFactory);
  }

  requestService<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  requestService<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  requestService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T>;
  requestService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.serviceReference("request", nameOrFactory, maybeFactory);
  }

  transientService<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  transientService<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  transientService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T>;
  transientService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.serviceReference("transient", nameOrFactory, maybeFactory);
  }

  private serviceReference<T>(
    scope: ServiceReference<T>["scope"],
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    const name = typeof nameOrFactory === "string" ? nameOrFactory : undefined;
    const factory = typeof nameOrFactory === "function" ? nameOrFactory : maybeFactory;
    if (!factory) throw new ConfigurationError("A service factory is required.");
    return { ...(name ? { name } : {}), scope, factory };
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

  async health(): Promise<HealthReport> {
    const providers: ProviderHealth[] = [];
    for (const provider of this.portProviders.values()) {
      if (!provider.lifecycle?.health) {
        providers.push({ status: "healthy", provider: provider.port.id });
        continue;
      }
      try {
        providers.push(await provider.lifecycle.health());
      } catch (error) {
        providers.push({
          status: "unhealthy",
          provider: provider.port.id,
          detail: error instanceof Error ? error.message : "Health check failed.",
        });
      }
    }
    const status = providers.some((provider) => provider.status === "unhealthy")
      ? "unhealthy"
      : providers.some((provider) => provider.status === "degraded")
      ? "degraded"
      : "healthy";
    return { status, providers };
  }

  async connectProviders(): Promise<void> {
    if (this.providersConnected) return;
    const connected: PortProvider<unknown>[] = [];
    try {
      for (const provider of this.portProviders.values()) {
        await provider.lifecycle?.connect?.();
        connected.push(provider);
      }
    } catch (error) {
      const errors: unknown[] = [error];
      for (const provider of connected.reverse()) {
        try {
          await provider.lifecycle?.close?.();
        } catch (closeError) {
          appendErrors(errors, closeError);
        }
      }
      throw createAggregateError(errors, "Provider connection failed.");
    }
    this.providersConnected = true;
  }

  private mountCoreMiddleware(): void {
    this.http.use("*", async (context, next) => {
      const request = context.req.raw;
      const requestId = request.headers.get(this.config.requestIdHeader) ?? crypto.randomUUID();
      const deadlineHeader = request.headers.get("x-hyapi-deadline");
      const deadline = deadlineHeader === null || deadlineHeader.trim() === ""
        ? undefined
        : Number(deadlineHeader);
      const state = new Map<string, unknown>();
      const runtime: RequestRuntime = {
        requestId,
        ...(deadline !== undefined && Number.isFinite(deadline) ? { deadline } : {}),
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
        services: new Map(),
        cleanups: [],
      };
      this.runtimeByRequest.set(request, runtime);

      let response: Response | null = null;
      let requestError: unknown;
      try {
        await this.runHooks("onRequest", runtime.lifecycle);
        await next();
        response = context.res;
        runtime.lifecycle.response = response;
        await this.runHooks("onResponse", runtime.lifecycle);
      } catch (error) {
        requestError = error;
      } finally {
        try {
          await this.dispose(runtime.cleanups);
        } catch (cleanupError) {
          const cleanupErrors = requestError === undefined
            ? [cleanupError]
            : [...flattenError(requestError), ...flattenError(cleanupError)];
          requestError = cleanupErrors.length > 1
            ? createAggregateError(cleanupErrors, "Request cleanup failed.")
            : cleanupErrors[0];
        }
        this.runtimeByRequest.delete(request);
      }
      if (requestError !== undefined) {
        runtime.lifecycle.error = requestError;
        const hookErrors: unknown[] = [];
        try {
          if (runtime.route) {
            const scoped = this.routeScopedHooks.get(runtime.route);
            if (scoped?.onError) {
              await this.runHookList(scoped.onError, runtime.lifecycle, true);
            }
          }
          await this.runHooks("onError", runtime.lifecycle, true);
        } catch (error) {
          hookErrors.push(...flattenError(error));
        }
        if (hookErrors.length > 0) {
          requestError = createAggregateError(
            [...flattenError(requestError), ...hookErrors],
            "Request handling and error hooks failed.",
          );
        }
        response = this.errorResponse(requestError, request, requestId);
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
      ? await parseRequestBody(request)
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
      ...(runtime.deadline === undefined ? {} : { deadline: runtime.deadline }),
      params,
      query,
      body,
      headers: new Headers(headers as Record<string, string>),
      identity,
      state: runtime.state,
      services: this.serviceResolver(runtime),
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

  private serviceResolver(runtime?: RequestRuntime): ServiceResolver {
    return {
      get: <T>(service: ServiceReference<T>) => this.resolveService(service, runtime),
    };
  }

  private resolveService<T>(
    service: ServiceReference<T>,
    runtime?: RequestRuntime,
  ): Promise<T> {
    if (service.name && this.serviceOverrides.has(service.name)) {
      return Promise.resolve(this.serviceOverrides.get(service.name) as T);
    }
    if (service.scope === "request" && !runtime) {
      return Promise.reject(
        new ConfigurationError(
          "A request-scoped service can only be resolved while handling a request.",
        ),
      );
    }
    if (service.scope === "transient") {
      return this.createService(service, runtime);
    }
    const services = service.scope === "singleton" ? this.singletonServices : runtime!.services;
    const existing = services.get(service as ServiceReference<unknown>);
    if (existing) return existing as Promise<T>;
    const created = this.createService(service, runtime);
    services.set(service as ServiceReference<unknown>, created);
    return created;
  }

  private async createService<T>(
    service: ServiceReference<T>,
    runtime?: RequestRuntime,
  ): Promise<T> {
    const value = await service.factory(this.serviceResolver(runtime));
    if (service.scope === "singleton") this.singletonCleanups.push(value);
    else if (service.scope === "request") runtime!.cleanups.push(value);
    return value;
  }

  private async dispose(values: readonly unknown[]): Promise<void> {
    const errors: unknown[] = [];
    for (const value of [...values].reverse()) {
      if (
        typeof value === "object" && value !== null &&
        "close" in value && typeof (value as { close?: unknown }).close === "function"
      ) {
        try {
          await (value as { close(): MaybePromise<void> }).close();
        } catch (error) {
          appendErrors(errors, error);
        }
      }
    }
    if (errors.length > 0) {
      throw createAggregateError(errors);
    }
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
    const hasProtectedRoutes = this.routes.some((route) => isProtectedAuth(route.auth));
    if (hasProtectedRoutes && !this.authProvider) {
      throw new ConfigurationError("Protected routes require an auth provider.");
    }
  }

  private async closeAfterInitialization(): Promise<void> {
    const errors: unknown[] = [];
    if (this.readyPromise) {
      try {
        await this.readyPromise;
      } catch (error) {
        appendErrors(errors, error);
      }
    }

    this.lifecycleState = "closing";
    try {
      await this.dispose(this.singletonCleanups);
    } catch (error) {
      appendErrors(errors, error);
    }
    for (const provider of this.portProviders.values()) {
      try {
        await provider.lifecycle?.close?.();
      } catch (error) {
        appendErrors(errors, error);
      }
    }
    this.lifecycleState = "closed";

    if (errors.length > 0) throw createAggregateError(errors);
  }
}

function toHonoPath(path: string): string {
  return path.replace(/\{([^}/]+)\}/g, ":$1");
}

export function createApp(options: HyApiOptions): HyApiApp {
  return new HyApiApp(options);
}

export async function createApplication(options: ApplicationOptions): Promise<HyApplication> {
  const app = createApp({ config: normalizeConfig(options.config) });
  app.setOverrides(options.overrides ?? []);
  const modules = sortModules(options.modules);
  const plugins = sortPlugins(options.plugins ?? []);
  app.setPortProviders([
    ...(options.providers ?? []),
    ...modules.flatMap((module) => module.provides ?? []),
  ]);
  for (const module of modules) {
    for (const port of module.requires ?? []) app.usePort(port);
  }
  const contexts = new Map<Module, ModuleContext>();

  for (const plugin of plugins) {
    await plugin.setup(app);
  }

  for (const module of modules) {
    const context = new ModuleContext(app);
    contexts.set(module, context);
    await module.setup(context);
  }

  await app.connectProviders();
  await app.ready();
  for (const plugin of plugins) {
    if (plugin.onStart) await plugin.onStart(app);
  }
  for (const module of modules) {
    await module.onStart?.(contexts.get(module)!);
  }
  let closePromise: Promise<void> | null = null;
  return {
    config: app.config,
    fetch: (request) => app.fetch(request),
    request: (input, init) => app.request(input, init),
    health: () => app.health(),
    close: () => {
      closePromise ??= (async () => {
        const errors: unknown[] = [];
        for (const module of [...modules].reverse()) {
          if (!module.onClose) continue;
          try {
            await module.onClose(contexts.get(module)!);
          } catch (error) {
            appendErrors(errors, error);
          }
        }
        for (const plugin of [...plugins].reverse()) {
          if (!plugin.onClose) continue;
          try {
            await plugin.onClose(app);
          } catch (error) {
            appendErrors(errors, error);
          }
        }
        try {
          await app.close();
        } catch (error) {
          if (error instanceof AggregateError) {
            appendErrors(errors, error);
          } else {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw createAggregateError(errors);
        }
      })();
      return closePromise;
    },
  };
}

function normalizeConfig(config: AppConfig | AppConfigOptions): AppConfig {
  if ("requestIdHeader" in config && "openapi" in config && config.openapi.path !== undefined) {
    return config as AppConfig;
  }
  const version = config.version ?? "0.1.0";
  return {
    name: config.name,
    version,
    environment: config.environment ?? "development",
    requestIdHeader: config.requestIdHeader ?? "x-request-id",
    openapi: {
      title: config.openapi?.title ?? `${config.name} API`,
      ...(config.openapi?.description === undefined
        ? {}
        : { description: config.openapi.description }),
      version: config.openapi?.version ?? version,
      path: config.openapi?.path ?? "/openapi.json",
    },
  };
}

export async function createTestApplication(options: ApplicationOptions): Promise<HyApplication> {
  return await createApplication(options);
}
