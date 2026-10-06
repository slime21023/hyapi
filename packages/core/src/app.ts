import { Hono } from "@hono/hono";
import {
  type AnyRouteDefinition,
  type ApplicationOptions,
  type HyApplication,
  type LifecycleHook,
  type Module,
  type ModuleApi,
  type PlatformApi,
  type ResponseSchemas,
  type RouteDefinition,
  type RouteGroupApi,
  type RouteGroupOptions,
  type Schema,
  type ServiceFactory,
  type ServiceReference,
} from "./types.ts";
import type { HealthCheck, HealthReport } from "./health.ts";
import { type Port, type PortProvider, providePort, type ProviderLifecycle } from "./port.ts";
import {
  type AppConfig,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  defineConfig,
} from "./config.ts";
import { AppError, ConfigurationError, NotFoundError } from "./errors.ts";
import { buildOpenApiDocument, selectOpenApiRoutes } from "./openapi.ts";
import { MAX_TIMER_MS } from "./runtime/timers.ts";
import { objectSchemaProperties, SchemaValidationError, SchemaValidator } from "./schema.ts";
import {
  type HookPoint,
  normalizeGroupArgs,
  type RouteHooks,
  type RouteRegistrar,
  RouterGroup,
} from "./routing.ts";
import { collectError, Scope } from "./runtime/scope.ts";
import { ServiceContainer } from "./runtime/services.ts";
import { HealthRegistry } from "./runtime/health.ts";
import { ProviderRegistry } from "./runtime/providers.ts";
import { type HttpPipelineEnv, HttpTaskTracker } from "./http/lifecycle.ts";
import { errorResponse, problemOptions } from "./http/problem.ts";
import {
  type PipelineHost,
  RequestPipeline,
  resolveRequestId,
  withHeader,
} from "./http/pipeline.ts";

/** Application options after configuration normalization; modules may be added in tests. */
type HyApiOptions = Omit<ApplicationOptions, "config" | "modules"> & {
  readonly config: AppConfig;
  readonly modules?: readonly Module[];
};

type AppLifecycleState =
  | "configuring"
  | "starting"
  | "running"
  | "draining"
  | "closing"
  | "closed"
  | "failed";

const NO_HOOKS: RouteHooks = { onRequest: [], onResponse: [], onError: [] };

/** Answer for requests that arrive while the application is not running. */
function unavailableError(): AppError {
  return new AppError(
    503,
    "APPLICATION_UNAVAILABLE",
    "The application is not accepting requests.",
    undefined,
    true,
  );
}

function validatedLimit(value: number, name: string, isValid: (value: number) => boolean): number {
  if (!isValid(value)) {
    throw new ConfigurationError(`${name} must be a positive integer of at most 2147483647.`);
  }
  return value;
}

function isTimerDelay(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_TIMER_MS;
}

interface DependencyNode {
  readonly name: string;
  readonly dependencies?: readonly string[];
}

function sortByDependencies<T extends DependencyNode>(
  items: readonly T[],
  kind: "Module" | "Plugin",
  implicitDependencies: (item: T) => readonly string[] = () => [],
): T[] {
  const byName = new Map<string, T>();
  for (const item of items) {
    if (byName.has(item.name)) {
      throw new ConfigurationError(`${kind} '${item.name}' is already registered.`);
    }
    byName.set(item.name, item);
  }

  for (const item of items) {
    for (const dependency of item.dependencies ?? []) {
      if (!byName.has(dependency)) {
        throw new ConfigurationError(
          `${kind} '${item.name}' requires '${dependency}' to be registered.`,
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting: string[] = [];
  const sorted: T[] = [];
  const visit = (name: string): void => {
    if (visiting.includes(name)) {
      throw new ConfigurationError(
        `Circular ${kind.toLowerCase()} dependency detected: ${[...visiting, name].join(" -> ")}.`,
      );
    }
    if (visited.has(name)) return;
    const item = byName.get(name)!;
    visiting.push(name);
    for (const dependency of item.dependencies ?? []) visit(dependency);
    for (const dependency of implicitDependencies(item)) visit(dependency);
    visiting.pop();
    visited.add(name);
    sorted.push(item);
  };

  for (const item of items) visit(item.name);
  return sorted;
}

/** Maps each module-provided Port id to its module, rejecting a Port declared twice. */
function modulePortProviders(modules: readonly Module[]): Map<string, string> {
  const providers = new Map<string, string>();
  for (const module of modules) {
    for (const port of module.provides ?? []) {
      const previous = providers.get(port.id);
      if (previous !== undefined) {
        throw new ConfigurationError(
          `Port '${port.id}' is provided by both '${previous}' and '${module.name}'.`,
        );
      }
      providers.set(port.id, module.name);
    }
  }
  return providers;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Validates every module's configuration entry before any module or plugin runs setup. */
function resolveModuleConfigs(
  modules: readonly Module[],
  entries: Readonly<Record<string, unknown>>,
  validator: SchemaValidator,
): Map<Module, unknown> {
  const byName = new Map(modules.map((module) => [module.name, module]));
  for (const name of Object.keys(entries)) {
    const module = byName.get(name);
    if (!module) {
      throw new ConfigurationError(`moduleConfig references unknown module '${name}'.`);
    }
    if (!module.config) {
      throw new ConfigurationError(`Module '${name}' does not declare a configuration schema.`);
    }
  }
  const configs = new Map<Module, unknown>();
  for (const module of modules) {
    if (!module.config) continue;
    const entry = Object.hasOwn(entries, module.name) ? entries[module.name] : {};
    try {
      configs.set(
        module,
        deepFreeze(validator.validateInput(module.config, structuredClone(entry))),
      );
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
      throw new ConfigurationError(`Module '${module.name}' configuration is invalid.`, {
        module: module.name,
        errors: error.issues,
      });
    }
  }
  return configs;
}

function toHonoPath(path: string): string {
  return path.replace(/\{([^}/]+)\}/g, ":$1");
}

/**
 * The application runtime. One state machine owns every lifecycle phase:
 * configuring → starting → running → draining → closing → closed (or failed).
 * Resources acquired while starting are released in reverse order by one application scope.
 */
export class HyApiApp implements RouteRegistrar, PipelineHost {
  readonly config: AppConfig;
  readonly validator = new SchemaValidator();
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly services: ServiceContainer;
  readonly tasks = new HttpTaskTracker();

  private readonly options: HyApiOptions;
  private readonly http = new Hono<HttpPipelineEnv>();
  private readonly pipeline: RequestPipeline;
  private readonly healthChecks = new HealthRegistry();
  private readonly providers = new ProviderRegistry();
  private readonly appScope = new Scope("Application shutdown failed.");
  private readonly providerScope = new Scope("Application shutdown failed.");
  private readonly singletonScope = new Scope("Application shutdown failed.");
  private readonly routes: AnyRouteDefinition[] = [];
  private readonly hooks: Record<HookPoint, LifecycleHook[]> = {
    onRequest: [],
    onResponse: [],
    onError: [],
  };
  private readonly routeScopes = new Map<AnyRouteDefinition, RouterGroup>();
  private readonly resolvedRouteHooks = new Map<AnyRouteDefinition, RouteHooks>();
  private state: AppLifecycleState = "configuring";
  private registrationOpen = true;
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly openApiDocuments = new Map<string, Record<string, unknown>>();

  constructor(options: HyApiOptions) {
    this.options = options;
    this.config = options.config;
    this.bodyLimitBytes = this.config.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    if (!Number.isSafeInteger(this.bodyLimitBytes) || this.bodyLimitBytes <= 0) {
      throw new ConfigurationError("bodyLimitBytes must be a positive integer.");
    }
    this.requestTimeoutMs = validatedLimit(
      this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
      isTimerDelay,
    );
    this.shutdownTimeoutMs = validatedLimit(
      this.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs",
      isTimerDelay,
    );
    this.services = new ServiceContainer(this.singletonScope);
    this.pipeline = new RequestPipeline(this);

    if (this.config.openapi.enabled !== false) {
      for (const document of this.config.openapi.documents) {
        this.http.get(
          document.path,
          (context) => context.json(this.openApiDocuments.get(document.id)!),
        );
      }
    }
    this.http.notFound((context) =>
      errorResponse(
        new NotFoundError(),
        context.env.scope.request,
        context.env.scope.requestId,
        problemOptions(this.config),
      )
    );
    this.http.onError((error, context) => this.pipeline.failure(context.env.scope, error));
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
    if (!this.registrationOpen) {
      throw new ConfigurationError(`Cannot ${action} after the application has started.`);
    }
  }

  addHook(point: HookPoint, hook: LifecycleHook): void {
    this.assertConfiguring("register hooks");
    this.hooks[point].push(hook);
  }

  route<
    TParams extends Schema | undefined = undefined,
    TQuery extends Schema | undefined = undefined,
    TBody extends Schema | undefined = undefined,
    TResponse extends ResponseSchemas | undefined = undefined,
    TBodyRequired extends boolean = true,
  >(
    route: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired>,
    scope?: RouterGroup,
  ): void {
    this.assertConfiguring("register routes");
    const registeredRoute = route as unknown as AnyRouteDefinition;
    const label = `${registeredRoute.method.toUpperCase()} ${registeredRoute.path}`;
    const honoPath = toHonoPath(registeredRoute.path);
    if (registeredRoute.request?.bodyRequired !== undefined && !registeredRoute.request.body) {
      throw new ConfigurationError("request.bodyRequired requires a request.body schema.");
    }
    if (registeredRoute.method === "get" && registeredRoute.request?.body) {
      throw new ConfigurationError(`Route '${label}' cannot declare a request body.`);
    }
    const paramsSchema = registeredRoute.request?.params;
    if (paramsSchema) {
      const properties = objectSchemaProperties(paramsSchema);
      if (properties) {
        const pathNames = new Set(
          [...honoPath.matchAll(/(?:^|\/):([^/?{]+)/g)].map((match) => match[1]),
        );
        const required = "required" in paramsSchema ? paramsSchema.required : undefined;
        for (const name of Array.isArray(required) ? required : []) {
          if (
            typeof name !== "string" || pathNames.has(name) ||
            (properties[name] && Object.hasOwn(properties[name], "default"))
          ) continue;
          throw new ConfigurationError(
            `Route '${label}' request.params requires '${name}', but its path has no matching parameter.`,
          );
        }
      }
    }
    const headersSchema = registeredRoute.request?.headers;
    if (headersSchema) {
      const properties = objectSchemaProperties(headersSchema);
      if (properties) {
        const spellings = new Map<string, string>();
        for (const name of Object.keys(properties)) {
          const lower = name.toLowerCase();
          const previous = spellings.get(lower);
          if (previous !== undefined) {
            throw new ConfigurationError(
              `Route '${label}' request.headers declares '${previous}' and '${name}' for the same HTTP header.`,
            );
          }
          spellings.set(lower, name);
        }
      }
    }
    for (const guard of registeredRoute.guards ?? []) {
      if (typeof guard?.check !== "function" || typeof guard.name !== "string") {
        throw new ConfigurationError(`Route '${label}' has an invalid guard.`);
      }
    }
    const documentIds = registeredRoute.metadata?.documentIds;
    if (documentIds) {
      const knownDocumentIds = new Set(
        this.config.openapi.documents.map((document) => document.id),
      );
      const seenDocumentIds = new Set<string>();
      for (const documentId of documentIds) {
        if (!knownDocumentIds.has(documentId)) {
          throw new ConfigurationError(
            `Route '${label}' references unknown OpenAPI document '${documentId}'.`,
          );
        }
        if (seenDocumentIds.has(documentId)) {
          throw new ConfigurationError(
            `Route '${label}' references OpenAPI document '${documentId}' more than once.`,
          );
        }
        seenDocumentIds.add(documentId);
      }
    }
    if (
      this.config.openapi.enabled !== false && registeredRoute.method === "get" &&
      this.config.openapi.documents.some((document) => document.path === registeredRoute.path)
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
    this.http.on(
      registeredRoute.method.toUpperCase(),
      honoPath,
      (context) => this.pipeline.runRoute(context, registeredRoute),
    );
  }

  globalHooks(point: HookPoint): readonly LifecycleHook[] {
    return this.hooks[point];
  }

  routeHooks(route: AnyRouteDefinition): RouteHooks {
    return this.resolvedRouteHooks.get(route) ?? NO_HOOKS;
  }

  usePort<T>(port: Port<T>): T {
    return this.providers.use(port);
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
    return this.services.reference("singleton", nameOrFactory, maybeFactory);
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
    return this.services.reference("request", nameOrFactory, maybeFactory);
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
    return this.services.reference("transient", nameOrFactory, maybeFactory);
  }

  async start(): Promise<void> {
    if (this.state === "running") return;
    if (this.state === "starting") return await this.starting!;
    if (this.state !== "configuring") {
      throw new ConfigurationError("The application cannot be initialized in its current state.");
    }
    this.state = "starting";
    this.starting = this.startup();
    await this.starting;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  fetch(request: Request): Promise<Response> {
    if (this.state !== "running") {
      const header = this.config.requestIdHeader;
      const requestId = resolveRequestId(request, header);
      return Promise.resolve(
        withHeader(
          errorResponse(unavailableError(), request, requestId, problemOptions(this.config)),
          header,
          requestId,
        ),
      );
    }
    const pending = this.pipeline.dispatch(request, this.http);
    this.tasks.track(pending);
    return pending;
  }

  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? new Request(input, init) : new Request(
      typeof input === "string" && !/^https?:\/\//i.test(input)
        ? `http://localhost/${input.startsWith("/") ? input.slice(1) : input}`
        : input,
      init,
    );
    return this.fetch(request);
  }

  async health(): Promise<HealthReport> {
    if (this.state !== "running") return { status: "unhealthy", checks: [] };
    return await this.healthChecks.check();
  }

  liveness(): HealthReport {
    const alive = this.state === "running" || this.state === "draining";
    return { status: alive ? "healthy" : "unhealthy", checks: [] };
  }

  addHealthCheck(check: HealthCheck): void {
    this.assertConfiguring("register health checks");
    this.healthChecks.register([check]);
  }

  /**
   * Acquires every resource in order and registers its release on the application scope, so a
   * failure at any step (and a later close) releases exactly what was acquired, in reverse.
   */
  private async startup(): Promise<void> {
    try {
      // Registered first so they close last: modules and plugins still reach them in onClose.
      this.appScope.defer((deadline) => this.providerScope.close(deadline));
      this.appScope.defer((deadline) => this.singletonScope.close(deadline));

      await this.services.setOverrides(this.options.overrides ?? []);
      this.healthChecks.register(this.options.healthChecks ?? []);
      const declaredModules = this.options.modules ?? [];
      const portProviders = modulePortProviders(declaredModules);
      const modules = sortByDependencies(
        declaredModules,
        "Module",
        (module) =>
          (module.requires ?? []).flatMap((port) => {
            const provider = portProviders.get(port.id);
            return provider !== undefined && provider !== module.name ? [provider] : [];
          }),
      );
      const plugins = sortByDependencies(this.options.plugins ?? [], "Plugin");
      const moduleConfigs = resolveModuleConfigs(
        modules,
        this.options.moduleConfig ?? {},
        this.validator,
      );
      this.providers.register(this.options.providers ?? []);
      for (const module of modules) {
        for (const port of module.requires ?? []) {
          if (!portProviders.has(port.id)) this.usePort(port);
        }
      }

      const platform = createPlatformApi(this);
      for (const plugin of plugins) {
        await plugin.setup(platform);
        if (plugin.onClose) this.appScope.defer(() => plugin.onClose!(platform));
      }
      const contexts = new Map<Module, ModuleContext>();
      for (const module of modules) {
        for (const port of module.requires ?? []) this.usePort(port);
        const context = new ModuleContext(this, module, moduleConfigs.get(module));
        contexts.set(module, context);
        await module.setup(context);
        if (module.onClose) this.appScope.defer(() => module.onClose!(context));
        this.providers.register(await context.resolveProviders());
      }

      this.registrationOpen = false;
      for (const route of this.routes) {
        const scope = this.routeScopes.get(route);
        this.resolvedRouteHooks.set(
          route,
          scope
            ? {
              onRequest: scope.collectHooks("onRequest"),
              onResponse: scope.collectHooks("onResponse"),
              onError: scope.collectHooks("onError"),
            }
            : NO_HOOKS,
        );
      }
      if (this.config.openapi.enabled !== false) {
        for (const document of this.config.openapi.documents) {
          this.openApiDocuments.set(
            document.id,
            buildOpenApiDocument(
              selectOpenApiRoutes(
                this.routes,
                document.id,
                this.config.openapi.defaultDocument,
              ),
              this.validator,
              document,
            ),
          );
        }
      }

      await this.providers.connect(this.providerScope, this.shutdownTimeoutMs);
      for (const plugin of plugins) await plugin.onStart?.(platform);
      for (const module of modules) await module.onStart?.(contexts.get(module)!);
      this.state = "running";
    } catch (error) {
      this.registrationOpen = false;
      const rollbackErrors: unknown[] = [];
      try {
        await this.appScope.close(Date.now() + this.shutdownTimeoutMs);
      } catch (closeError) {
        collectError(rollbackErrors, closeError);
      }
      this.state = "failed";
      if (rollbackErrors.length === 0) throw error;
      const errors: unknown[] = [];
      collectError(errors, error);
      errors.push(...rollbackErrors);
      throw new AggregateError(errors, "Application startup failed.", {
        cause: error,
      });
    }
  }

  /**
   * Stops admitting requests, waits up to `shutdownTimeoutMs` for in-flight and abandoned work,
   * aborts whatever remains, then releases the application scope.
   */
  private async shutdown(): Promise<void> {
    if (this.state === "starting") await this.starting!.catch(() => undefined);
    if (this.state === "failed" || this.state === "closed") return;
    if (this.state === "running") {
      this.state = "draining";
      const drained = await this.tasks.idle(this.shutdownTimeoutMs);
      if (!drained) {
        this.tasks.abortAll(unavailableError());
        await this.tasks.idle(Math.min(1_000, this.shutdownTimeoutMs));
      }
    }
    this.state = "closing";
    this.registrationOpen = false;
    try {
      await this.appScope.close(Date.now() + this.shutdownTimeoutMs);
    } finally {
      this.state = "closed";
    }
  }
}

interface PendingProvider {
  readonly port: Port<unknown>;
  readonly factory: ServiceFactory<unknown>;
  readonly lifecycle: ProviderLifecycle | undefined;
}

class ModuleContext extends RouterGroup implements ModuleApi {
  readonly config: unknown;
  readonly #app: HyApiApp;
  readonly #moduleName: string;
  readonly #requiredPortIds: ReadonlySet<string>;
  readonly #declaredPorts: ReadonlyMap<string, Port<unknown>>;
  readonly #provided = new Map<string, PendingProvider>();

  constructor(app: HyApiApp, module: Module, config: unknown) {
    super(app);
    this.config = config;
    this.#app = app;
    this.#moduleName = module.name;
    this.#requiredPortIds = new Set(module.requires?.map((port) => port.id));
    this.#declaredPorts = new Map(module.provides?.map((port) => [port.id, port]));
  }

  provide<T>(port: Port<T>, factory: ServiceFactory<T>, lifecycle?: ProviderLifecycle): void {
    this.#app.assertConfiguring("provide ports");
    const declared = this.#declaredPorts.get(port.id);
    if (!declared) {
      throw new ConfigurationError(
        `Module '${this.#moduleName}' provides port '${port.id}' without declaring it in provides.`,
      );
    }
    if (this.#provided.has(port.id)) {
      throw new ConfigurationError(
        `Module '${this.#moduleName}' provides port '${port.id}' more than once.`,
      );
    }
    this.#provided.set(port.id, {
      port: declared,
      factory: factory as ServiceFactory<unknown>,
      lifecycle,
    });
  }

  /** Resolves this module's provider factories once its setup has completed. */
  async resolveProviders(): Promise<PortProvider<unknown>[]> {
    for (const id of this.#declaredPorts.keys()) {
      if (!this.#provided.has(id)) {
        throw new ConfigurationError(
          `Module '${this.#moduleName}' declares port '${id}' in provides but did not provide it.`,
        );
      }
    }
    const providers: PortProvider<unknown>[] = [];
    for (const { port, factory, lifecycle } of this.#provided.values()) {
      const value = await factory(this.#app.services.resolver());
      providers.push(providePort(port, value, lifecycle));
    }
    return providers;
  }

  healthCheck(check: HealthCheck): void {
    this.#app.addHealthCheck(check);
  }

  health(): Promise<HealthReport> {
    return this.#app.health();
  }

  liveness(): HealthReport {
    return this.#app.liveness();
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

export function createApp(options: HyApiOptions): HyApiApp {
  return new HyApiApp(options);
}

function createPlatformApi(app: HyApiApp): PlatformApi {
  const platform: PlatformApi = {
    addHook: (point, hook) => app.addHook(point, hook),
  };
  return Object.freeze(platform);
}

/**
 * Returns a module unchanged so TypeScript can infer `module.config` from its schema.
 *
 * @example
 * ```ts
 * const orders = defineModule({
 *   name: "orders",
 *   config: Type.Object({ pageSize: Type.Integer({ default: 20 }) }),
 *   setup(module) {
 *     module.config.pageSize; // number
 *   },
 * });
 * ```
 */
export function defineModule<TConfig extends Schema | undefined = undefined>(
  module: Module<TConfig>,
): Module<TConfig> {
  return module;
}

/**
 * Composes, starts, and returns an application facade.
 *
 * @example
 * ```ts
 * const app = await createApplication({
 *   config: { name: "catalog" },
 *   modules: [],
 * });
 * await app.close();
 * ```
 *
 * @param options Application configuration, modules, plugins, and providers.
 */
export async function createApplication(options: ApplicationOptions): Promise<HyApplication> {
  const app = new HyApiApp({ ...options, config: defineConfig(options.config) });
  await app.start();
  return {
    config: app.config,
    fetch: (request) => app.fetch(request),
    request: (input, init) => app.request(input, init),
    health: () => app.health(),
    liveness: () => app.liveness(),
    close: () => app.close(),
  };
}
