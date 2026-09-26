import { Hono } from "@hono/hono";
import {
  type AnyRouteDefinition,
  type ApplicationOptions,
  type AuthProvider,
  type HealthReport,
  type HyApiOptions,
  type HyApplication,
  type LifecycleHook,
  type Module,
  type PlatformApi,
  type Port,
  type ResponseSchemas,
  type RouteDefinition,
  type RouteGroupApi,
  type RouteGroupOptions,
  type Schema,
  type ServiceFactory,
  type ServiceReference,
} from "./types.ts";
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
import { objectSchemaProperties, SchemaValidator } from "./http/validation.ts";
import {
  type HookPoint,
  isProtectedAuth,
  ModuleContext,
  normalizeGroupArgs,
  type RouteHooks,
  type RouteRegistrar,
  RouterGroup,
  sortModules,
  sortPlugins,
  toHonoPath,
} from "./routing.ts";
import { collectError, Scope } from "./runtime/scope.ts";
import { ServiceContainer } from "./runtime/services.ts";
import { ProviderRegistry } from "./runtime/providers.ts";
import {
  errorResponse,
  type PipelineEnv,
  type PipelineHost,
  RequestPipeline,
  resolveRequestId,
  TaskTracker,
  withHeader,
} from "./http/pipeline.ts";

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
  readonly tasks = new TaskTracker();

  private readonly options: HyApiOptions;
  private readonly http = new Hono<PipelineEnv>();
  private readonly pipeline: RequestPipeline;
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
  private auth: AuthProvider | null = null;
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
      errorResponse(new NotFoundError(), context.env.scope.request, context.env.scope.requestId)
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
          [...toHonoPath(registeredRoute.path).matchAll(/(?:^|\/):([^/?{]+)/g)].map((match) =>
            match[1]
          ),
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
      toHonoPath(registeredRoute.path),
      (context) => this.pipeline.runRoute(context, registeredRoute),
    );
  }

  setAuthProvider(provider: AuthProvider): void {
    this.assertConfiguring("register an auth provider");
    if (this.auth) throw new ConfigurationError("An auth provider is already registered.");
    this.auth = provider;
  }

  authProvider(): AuthProvider | null {
    return this.auth;
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
    if (this.starting) return await this.starting;
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
        withHeader(errorResponse(unavailableError(), request, requestId), header, requestId),
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
    if (this.state !== "running") return { status: "unhealthy", providers: [] };
    return await this.providers.health();
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

      this.services.setOverrides(this.options.overrides ?? []);
      const modules = sortModules(this.options.modules ?? []);
      const plugins = sortPlugins(this.options.plugins ?? []);
      this.providers.register([
        ...(this.options.providers ?? []),
        ...modules.flatMap((module) => module.provides ?? []),
      ]);
      for (const module of modules) {
        for (const port of module.requires ?? []) this.usePort(port);
      }

      const platform = createPlatformApi(this);
      for (const plugin of plugins) {
        await plugin.setup(platform);
        if (plugin.onClose) this.appScope.defer(() => plugin.onClose!(platform));
      }
      const contexts = new Map<Module, ModuleContext>();
      for (const module of modules) {
        const context = new ModuleContext(this, module);
        contexts.set(module, context);
        await module.setup(context);
        if (module.onClose) this.appScope.defer(() => module.onClose!(context));
      }

      this.registrationOpen = false;
      if (this.routes.some((route) => isProtectedAuth(route.auth)) && !this.auth) {
        throw new ConfigurationError("Protected routes require an auth provider.");
      }
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
    if (this.starting) await this.starting.catch(() => undefined);
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

export async function createApplication(options: ApplicationOptions): Promise<HyApplication> {
  const app = new HyApiApp({ ...options, config: defineConfig(options.config) });
  await app.start();
  return {
    config: app.config,
    fetch: (request) => app.fetch(request),
    request: (input, init) => app.request(input, init),
    health: () => app.health(),
    close: () => app.close(),
  };
}
