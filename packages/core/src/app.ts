import { type Context, Hono } from "@hono/hono";
import {
  type AnyRouteDefinition,
  type AppConfig,
  type AppConfigOptions,
  type ApplicationOptions,
  type AuthProvider,
  type AuthRequirement,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  defineConfig,
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
  type PlatformApi,
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
import { DEADLINE_HEADER, parseDeadlineHeader } from "./deadline.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { MAX_TIMER_MS } from "./resilience.ts";
import { headerObject, parseRequestBody, queryObject, SchemaValidator } from "./validation.ts";
import { formatContractVersion, isCompatibleContractVersion } from "./version.ts";

interface DependencyNode {
  readonly name: string;
  readonly dependencies?: readonly string[];
}

interface RequestRuntime {
  requestId: string;
  deadline: number;
  deadlineSource: "header" | "timeout";
  abort: AbortController;
  state: Map<string, unknown>;
  route: AnyRouteDefinition | null;
  identity: Identity | null;
  lifecycle: LifecycleContext;
  services: Map<ServiceReference<unknown>, Promise<unknown>>;
  cleanups: unknown[];
}

type HookPoint = "onRequest" | "onResponse" | "onError";
type RouteHooks = Readonly<Record<HookPoint, readonly LifecycleHook[]>>;

type AppLifecycleState = "configuring" | "starting" | "ready" | "failed" | "closing" | "closed";

const RESPONSE_RESULT = "__hyapiResponse" as const;
const PROVIDER_HEALTH_TIMEOUT_MS = 5_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isResponseResult(value: unknown): value is ResponseResult {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)[RESPONSE_RESULT] === true;
}

function isProviderHealth(value: unknown): value is ProviderHealth {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  return (report.status === "healthy" || report.status === "degraded" ||
    report.status === "unhealthy") && typeof report.provider === "string";
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

function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
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

function mergeAuth(
  parent: AuthRequirement | undefined,
  child: AuthRequirement | undefined,
  location: string,
): AuthRequirement | undefined {
  if (child === undefined) return parent;
  if (parent === undefined || parent === false) return child;
  if (child === false) {
    throw new ConfigurationError(
      `${location} cannot disable authentication inherited from its group.`,
    );
  }
  if (parent.required !== false && child.required === false) {
    throw new ConfigurationError(
      `${location} cannot make inherited required authentication optional.`,
    );
  }
  const scopes = [...new Set([...(parent.scopes ?? []), ...(child.scopes ?? [])])];
  return {
    ...(parent.required === false && child.required === false ? { required: false } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
  };
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
  readonly #app: HyApiApp;
  readonly #options: RouteGroupOptions;
  readonly #parent: RouterGroup | null;
  readonly #hooks: Record<HookPoint, LifecycleHook[]> = {
    onRequest: [],
    onResponse: [],
    onError: [],
  };

  constructor(app: HyApiApp, options: RouteGroupOptions = {}, parent: RouterGroup | null = null) {
    this.#app = app;
    this.#options = options;
    this.#parent = parent;
  }

  addHook(point: HookPoint, hook: LifecycleHook): void {
    this.#app.assertConfiguring("register hooks");
    this.#hooks[point].push(hook);
  }

  /**
   * onRequest hooks run outer to inner; onResponse and onError hooks run inner to outer.
   */
  collectHooks(point: HookPoint): LifecycleHook[] {
    const inherited = this.#parent?.collectHooks(point) ?? [];
    return point === "onRequest"
      ? [...inherited, ...this.#hooks[point]]
      : [...this.#hooks[point], ...inherited];
  }

  route<
    TParams extends Schema | undefined,
    TQuery extends Schema | undefined,
    TBody extends Schema | undefined,
    TResponse extends ResponseSchemas | undefined,
    TBodyRequired extends boolean = true,
  >(route: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired>): void {
    const fullPath = joinPaths(this.#options.prefix, route.path);
    const mergedTags = [
      ...new Set([...(this.#options.tags ?? []), ...(route.metadata?.tags ?? [])]),
    ];
    const resolvedAuth = mergeAuth(
      this.#options.auth,
      route.auth,
      `Route '${route.method.toUpperCase()} ${fullPath}'`,
    );

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

    this.#app.route(mergedRoute as unknown as AnyRouteDefinition, this);
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
    const mergedPrefix = joinPaths(this.#options.prefix, childOpts.prefix ?? "");
    const mergedTags = [...new Set([...(this.#options.tags ?? []), ...(childOpts.tags ?? [])])];
    const mergedAuth = mergeAuth(
      this.#options.auth,
      childOpts.auth,
      `Group '${mergedPrefix || "/"}'`,
    );

    const newOpts: RouteGroupOptions = {};
    if (mergedPrefix) newOpts.prefix = mergedPrefix;
    if (mergedTags.length > 0) newOpts.tags = mergedTags;
    if (mergedAuth !== undefined) newOpts.auth = mergedAuth;

    fn(new RouterGroup(this.#app, newOpts, this));
  }
}

class ModuleContext extends RouterGroup implements ModuleApi {
  readonly #app: HyApiApp;
  readonly #moduleName: string;
  readonly #requiredPortIds: ReadonlySet<string>;

  constructor(app: HyApiApp, module: Module) {
    super(app);
    this.#app = app;
    this.#moduleName = module.name;
    this.#requiredPortIds = new Set(module.requires?.map((port) => port.id));
  }

  singleton<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  singleton<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  singleton<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.#app.singletonService(nameOrFactory, maybeFactory);
  }

  request<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  request<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.#app.requestService(nameOrFactory, maybeFactory);
  }

  transient<T>(factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(name: string, factory: ServiceFactory<T>): ServiceReference<T>;
  transient<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    return this.#app.transientService(nameOrFactory, maybeFactory);
  }

  use<T>(port: Port<T>): T {
    if (!this.#requiredPortIds.has(port.id)) {
      throw new ConfigurationError(
        `Module '${this.#moduleName}' uses port '${port.id}' without declaring it in requires.`,
      );
    }
    return this.#app.usePort(port);
  }
}

export class HyApiApp {
  private readonly http: Hono;
  readonly config: AppConfig;
  readonly validator = new SchemaValidator();

  private readonly bodyLimitBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly routes: AnyRouteDefinition[] = [];
  private readonly hooks: Record<HookPoint, LifecycleHook[]> = {
    onRequest: [],
    onResponse: [],
    onError: [],
  };
  private readonly routeScopes = new WeakMap<AnyRouteDefinition, RouterGroup>();
  private readonly resolvedRouteHooks = new WeakMap<AnyRouteDefinition, RouteHooks>();
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
  private openApiDocument: Record<string, unknown> | null = null;

  constructor(options: HyApiOptions) {
    this.config = options.config;
    const bodyLimitBytes = this.config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes <= 0) {
      throw new ConfigurationError("bodyLimitBytes must be a positive integer.");
    }
    this.bodyLimitBytes = bodyLimitBytes;
    const requestTimeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 ||
      requestTimeoutMs > MAX_TIMER_MS
    ) {
      throw new ConfigurationError(
        "requestTimeoutMs must be a positive integer of at most 2147483647.",
      );
    }
    this.requestTimeoutMs = requestTimeoutMs;

    this.http = new Hono();
    this.mountCoreMiddleware();
    if (this.config.openapi.enabled !== false) {
      this.http.get(this.config.openapi.path, (context) => {
        if (this.openApiDocument) return context.json(this.openApiDocument);
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
        if (this.lifecycleState === "ready") this.openApiDocument = document;
        return context.json(document);
      });
    }
    this.http.notFound((context) => {
      const request = context.req.raw;
      const requestId = this.runtimeByRequest.get(request)?.requestId ??
        this.resolveRequestId(request);
      return this.errorResponse(new NotFoundError(), request, requestId);
    });
    this.http.onError(async (error, context) => {
      const request = context.req.raw;
      const runtime = this.runtimeByRequest.get(request);
      if (runtime) await this.notifyError(runtime, error);
      return this.errorResponse(
        error,
        request,
        runtime?.requestId ?? this.resolveRequestId(request),
      );
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
    const rootGroup = new RouterGroup(this, {}, null);
    const { options, fn } = normalizeGroupArgs(prefixOrOptions, optionsOrFn, maybeFn);
    rootGroup.group(options, fn);
  }

  assertConfiguring(action: string): void {
    if (this.lifecycleState !== "configuring") {
      throw new ConfigurationError(`Cannot ${action} after the application has started.`);
    }
  }

  addHook(point: HookPoint, hook: LifecycleHook): void {
    this.assertConfiguring("register hooks");
    this.hooks[point].push(hook);
  }

  route(route: AnyRouteDefinition, scope?: RouterGroup): void;
  route<
    TParams extends Schema | undefined,
    TQuery extends Schema | undefined,
    TBody extends Schema | undefined,
    TResponse extends ResponseSchemas | undefined,
    TBodyRequired extends boolean = true,
  >(
    route: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired>,
    scope?: RouterGroup,
  ): void {
    this.assertConfiguring("register routes");
    const registeredRoute = route as unknown as AnyRouteDefinition;
    const label = `${registeredRoute.method.toUpperCase()} ${registeredRoute.path}`;
    if (registeredRoute.request?.bodyRequired !== undefined && !registeredRoute.request.body) {
      throw new ConfigurationError("request.bodyRequired requires a request.body schema.");
    }
    if (registeredRoute.method === "get" && registeredRoute.request?.body) {
      throw new ConfigurationError(`Route '${label}' cannot declare a request body.`);
    }
    if (
      this.config.openapi.enabled !== false && registeredRoute.method === "get" &&
      registeredRoute.path === this.config.openapi.path
    ) {
      throw new ConfigurationError(`Route '${label}' conflicts with the OpenAPI document route.`);
    }
    if (
      this.routes.some((registered) =>
        registered.method === registeredRoute.method && registered.path === registeredRoute.path
      )
    ) {
      throw new ConfigurationError(`Route '${label}' is already registered.`);
    }
    this.routes.push(registeredRoute);
    if (scope) this.routeScopes.set(registeredRoute, scope);
    const handler = (context: Context) => this.handleRoute(context, registeredRoute);
    const honoPath = toHonoPath(registeredRoute.path);
    this.http.on(registeredRoute.method.toUpperCase(), honoPath, handler);
  }

  setAuthProvider(provider: AuthProvider): void {
    this.assertConfiguring("register an auth provider");
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
    const providers = await Promise.all(
      [...this.portProviders.values()].map((provider) => this.providerHealth(provider)),
    );
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

  private async providerHealth(provider: PortProvider<unknown>): Promise<ProviderHealth> {
    const id = provider.port.id;
    const lifecycle = provider.lifecycle;
    if (!lifecycle?.health) return { status: "healthy", provider: id };
    const { promise: timedOut, resolve } = Promise.withResolvers<ProviderHealth>();
    const timer = setTimeout(() =>
      resolve({
        status: "unhealthy",
        provider: id,
        detail: `Health check timed out after ${PROVIDER_HEALTH_TIMEOUT_MS} ms.`,
      }), PROVIDER_HEALTH_TIMEOUT_MS);
    try {
      const report: unknown = await Promise.race([
        Promise.resolve().then(() => lifecycle.health?.()),
        timedOut,
      ]);
      if (!isProviderHealth(report)) {
        return {
          status: "unhealthy",
          provider: id,
          detail: "Health check returned an invalid report.",
        };
      }
      return report;
    } catch (error) {
      return {
        status: "unhealthy",
        provider: id,
        detail: error instanceof Error ? error.message : "Health check failed.",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveRequestId(request: Request): string {
    const incoming = request.headers.get(this.config.requestIdHeader);
    return incoming !== null && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
  }

  private routeHooks(route: AnyRouteDefinition): RouteHooks {
    const cached = this.resolvedRouteHooks.get(route);
    if (cached) return cached;
    const scope = this.routeScopes.get(route);
    const hooks: RouteHooks = {
      onRequest: scope?.collectHooks("onRequest") ?? [],
      onResponse: scope?.collectHooks("onResponse") ?? [],
      onError: scope?.collectHooks("onError") ?? [],
    };
    if (this.lifecycleState === "ready") this.resolvedRouteHooks.set(route, hooks);
    return hooks;
  }

  private mountCoreMiddleware(): void {
    this.http.use("*", async (context, next) => {
      const request = context.req.raw;
      const requestId = this.resolveRequestId(request);
      const timeoutDeadline = Date.now() + this.requestTimeoutMs;
      const headerDeadline = parseDeadlineHeader(request.headers.get(DEADLINE_HEADER));
      const fromHeader = headerDeadline !== undefined && headerDeadline <= timeoutDeadline;
      const state = new Map<string, unknown>();
      const runtime: RequestRuntime = {
        requestId,
        deadline: fromHeader ? headerDeadline : timeoutDeadline,
        deadlineSource: fromHeader ? "header" : "timeout",
        abort: new AbortController(),
        state,
        route: null,
        identity: null,
        lifecycle: {
          request,
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
          if (requestError === undefined) {
            // A cleanup failure must not replace a response that already succeeded.
            await this.notifyError(runtime, cleanupError);
          } else {
            requestError = createAggregateError(
              [...flattenError(requestError), ...flattenError(cleanupError)],
              "Request cleanup failed.",
            );
          }
        }
        this.runtimeByRequest.delete(request);
      }
      if (requestError !== undefined) {
        await this.notifyError(runtime, requestError);
        response = this.errorResponse(requestError, request, requestId);
      }

      if (response) {
        context.res = withHeader(response, this.config.requestIdHeader, requestId);
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

    const hooks = this.routeHooks(route);
    let response: Response;
    try {
      response = await this.runWithinDeadline(
        runtime,
        () => this.executeRoute(context, route, runtime, hooks),
      );
    } catch (error) {
      response = await this.routeErrorResponse(error, request, runtime);
    }
    runtime.lifecycle.response = response;
    try {
      await this.runHookList(hooks.onResponse, runtime.lifecycle);
    } catch (error) {
      response = await this.routeErrorResponse(error, request, runtime);
      runtime.lifecycle.response = response;
    }
    return response;
  }

  private deadlineError(runtime: RequestRuntime): AppError {
    return runtime.deadlineSource === "timeout"
      ? new AppError(
        503,
        "REQUEST_TIMEOUT",
        `The request did not complete within ${this.requestTimeoutMs} ms.`,
        undefined,
        true,
      )
      : new AppError(504, "DEADLINE_EXCEEDED", "The request deadline has passed.", undefined, true);
  }

  /**
   * Races the route pipeline against the effective request deadline. JavaScript cannot stop a
   * running handler, so the deadline aborts `ctx.signal` and the late result is discarded.
   */
  private async runWithinDeadline<T>(
    runtime: RequestRuntime,
    operation: () => Promise<T>,
  ): Promise<T> {
    const remaining = runtime.deadline - Date.now();
    if (remaining <= 0) throw this.deadlineError(runtime);
    const { promise: expired, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      const error = this.deadlineError(runtime);
      runtime.abort.abort(error);
      reject(error);
    }, remaining);
    const execution = operation();
    execution.catch(() => undefined);
    try {
      return await Promise.race([execution, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async executeRoute(
    context: Context,
    route: AnyRouteDefinition,
    runtime: RequestRuntime,
    hooks: RouteHooks,
  ): Promise<Response> {
    const request = context.req.raw;
    await this.runHookList(hooks.onRequest, runtime.lifecycle);

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
      ? await parseRequestBody(request, this.bodyLimitBytes)
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
      requestId: runtime.requestId,
      requestIdHeader: this.config.requestIdHeader,
      deadline: runtime.deadline,
      signal: runtime.abort.signal,
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
    return await this.toResponse(result, route);
  }

  private async routeErrorResponse(
    error: unknown,
    request: Request,
    runtime: RequestRuntime,
  ): Promise<Response> {
    await this.notifyError(runtime, error);
    return this.errorResponse(error, request, runtime.requestId);
  }

  /** Runs route-scoped and global onError hooks; hook failures are swallowed. */
  private async notifyError(runtime: RequestRuntime, error: unknown): Promise<void> {
    runtime.lifecycle.error = error;
    if (runtime.route) {
      await this.runHookList(this.routeHooks(runtime.route).onError, runtime.lifecycle, true);
    }
    await this.runHooks("onError", runtime.lifecycle, true);
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
          "A request-scoped service cannot be resolved outside a request or from a singleton factory.",
        ),
      );
    }
    if (service.scope === "transient") {
      return this.createService(service, runtime);
    }
    const services = service.scope === "singleton" ? this.singletonServices : runtime!.services;
    const key = service as ServiceReference<unknown>;
    const existing = services.get(key);
    if (existing) return existing as Promise<T>;
    const created = this.createService(service, runtime);
    services.set(key, created);
    // A failed factory must not poison the cache; the next resolution retries it.
    created.catch(() => {
      if (services.get(key) === created) services.delete(key);
    });
    return created;
  }

  private async createService<T>(
    service: ServiceReference<T>,
    runtime?: RequestRuntime,
  ): Promise<T> {
    const value = await service.factory(
      this.serviceResolver(service.scope === "singleton" ? undefined : runtime),
    );
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

  private async toResponse(result: unknown, route: AnyRouteDefinition): Promise<Response> {
    let body = result;
    const defaultStatus = route.responseStatus ??
      (route.method === "post" ? 201 : route.method === "delete" ? 204 : 200);
    let init: ResponseInit = { status: defaultStatus };
    if (isResponseResult(result)) {
      body = result.body;
      init = result.init ?? init;
    }
    const status = result instanceof Response ? result.status : init.status ?? defaultStatus;

    const declaredResponses = route.responses;
    if (declaredResponses && !Object.hasOwn(declaredResponses, status)) {
      if (result instanceof Response) await result.body?.cancel().catch(() => undefined);
      throw new ResponseContractError(
        `Response status ${status} is not declared for '${route.method.toUpperCase()} ${route.path}'.`,
        { status, declaredStatuses: Object.keys(declaredResponses).map(Number) },
      );
    }
    if (result instanceof Response) return result;

    const responseSchemas = extractResponseSchemas(route);
    const hasResponseContract = declaredResponses !== undefined;
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
    point: HookPoint,
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
    if (this.providersConnected) {
      for (const provider of [...this.portProviders.values()].reverse()) {
        try {
          await provider.lifecycle?.close?.();
        } catch (error) {
          appendErrors(errors, error);
        }
      }
      this.providersConnected = false;
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

function createPlatformApi(app: HyApiApp): PlatformApi {
  const platform: PlatformApi = {
    addHook: (point, hook) => app.addHook(point, hook),
    setAuthProvider: (provider) => app.setAuthProvider(provider),
  };
  return Object.freeze(platform);
}

/** Closes modules and plugins in reverse order, then the app; every failure is collected. */
async function closeComposition(
  modules: readonly Module[],
  plugins: readonly Plugin[],
  contexts: ReadonlyMap<Module, ModuleContext>,
  platform: PlatformApi,
  app: HyApiApp,
): Promise<unknown[]> {
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
      await plugin.onClose(platform);
    } catch (error) {
      appendErrors(errors, error);
    }
  }
  try {
    await app.close();
  } catch (error) {
    appendErrors(errors, error);
  }
  return errors;
}

export async function createApplication(options: ApplicationOptions): Promise<HyApplication> {
  const app = createApp({ config: normalizeConfig(options.config) });
  const platform = createPlatformApi(app);
  const contexts = new Map<Module, ModuleContext>();
  const setUpPlugins: Plugin[] = [];
  const setUpModules: Module[] = [];
  let modules: Module[] = [];
  let plugins: Plugin[] = [];
  try {
    app.setOverrides(options.overrides ?? []);
    modules = sortModules(options.modules);
    plugins = sortPlugins(options.plugins ?? []);
    app.setPortProviders([
      ...(options.providers ?? []),
      ...modules.flatMap((module) => module.provides ?? []),
    ]);
    for (const module of modules) {
      for (const port of module.requires ?? []) app.usePort(port);
    }

    for (const plugin of plugins) {
      await plugin.setup(platform);
      setUpPlugins.push(plugin);
    }

    for (const module of modules) {
      const context = new ModuleContext(app, module);
      contexts.set(module, context);
      await module.setup(context);
      setUpModules.push(module);
    }

    await app.connectProviders();
    await app.ready();
    for (const plugin of plugins) {
      await plugin.onStart?.(platform);
    }
    for (const module of modules) {
      await module.onStart?.(contexts.get(module)!);
    }
  } catch (error) {
    // close() reports a failed ready() again; drop that duplicate of the original error.
    const rollbackErrors = (await closeComposition(
      setUpModules,
      setUpPlugins,
      contexts,
      platform,
      app,
    )).filter((rollbackError) => rollbackError !== error);
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Application startup failed.", {
        cause: error,
      });
    }
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  return {
    config: app.config,
    fetch: (request) => app.fetch(request),
    request: (input, init) => app.request(input, init),
    health: () => app.health(),
    close: () =>
      closePromise ??= closeComposition(modules, plugins, contexts, platform, app).then(
        (errors) => {
          if (errors.length > 0) throw createAggregateError(errors);
        },
      ),
  };
}

function normalizeConfig(config: AppConfig | AppConfigOptions): AppConfig {
  if ("requestIdHeader" in config && config.openapi?.path !== undefined) {
    return config as AppConfig;
  }
  return defineConfig(config);
}
