import type {
  AnyRouteDefinition,
  AuthRequirement,
  LifecycleHook,
  Module,
  ModuleApi,
  Plugin,
  Port,
  ResponseSchemas,
  RouteDefinition,
  RouteGroupApi,
  RouteGroupOptions,
  Schema,
  ServiceFactory,
  ServiceReference,
} from "./types.ts";
import { ConfigurationError } from "./errors.ts";

export type HookPoint = "onRequest" | "onResponse" | "onError";
export type RouteHooks = Readonly<Record<HookPoint, readonly LifecycleHook[]>>;

/** The application operations route groups and module contexts delegate to. */
export interface RouteRegistrar {
  assertConfiguring(action: string): void;
  route(route: AnyRouteDefinition, scope?: RouterGroup): void;
  singletonService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T>;
  requestService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T>;
  transientService<T>(
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T>;
  usePort<T>(port: Port<T>): T;
}

interface DependencyNode {
  readonly name: string;
  readonly dependencies?: readonly string[];
}

export function joinPaths(base: string | undefined, path: string): string {
  const cleanBase = (base ?? "").trim().replace(/\/+$/, "");
  const cleanPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleanBase && !cleanPath) return "/";
  if (!cleanBase) return `/${cleanPath}`;
  if (!cleanPath) return cleanBase.startsWith("/") ? cleanBase : `/${cleanBase}`;
  const formattedBase = cleanBase.startsWith("/") ? cleanBase : `/${cleanBase}`;
  return `${formattedBase}/${cleanPath}`;
}

export function toHonoPath(path: string): string {
  return path.replace(/\{([^}/]+)\}/g, ":$1");
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

export function sortModules(modules: readonly Module[]): Module[] {
  return sortByDependencies(modules, {
    getDependencies: (module) => module.dependencies,
    getDuplicateMessage: (name) => `Module '${name}' is already registered.`,
    getMissingDependencyMessage: (dependent, dependency) =>
      `Module '${dependent}' requires '${dependency}' to be registered.`,
    getCycleMessage: (cycle) => `Circular module dependency detected: ${cycle.join(" -> ")}.`,
  });
}

export function sortPlugins(plugins: readonly Plugin[]): Plugin[] {
  return sortByDependencies(plugins, {
    getDuplicateMessage: (name) => `Plugin '${name}' is already registered.`,
    getMissingDependencyMessage: (dependent, dependency) =>
      `Plugin '${dependent}' requires '${dependency}' to be registered.`,
    getCycleMessage: (cycle) => `Circular plugin dependency detected: ${cycle.join(" -> ")}.`,
  });
}

export function normalizeGroupArgs(
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
  readonly #app: RouteRegistrar;
  readonly #options: RouteGroupOptions;
  readonly #parent: RouterGroup | null;
  readonly #hooks: Record<HookPoint, LifecycleHook[]> = {
    onRequest: [],
    onResponse: [],
    onError: [],
  };

  constructor(
    app: RouteRegistrar,
    options: RouteGroupOptions = {},
    parent: RouterGroup | null = null,
  ) {
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

export class ModuleContext extends RouterGroup implements ModuleApi {
  readonly #app: RouteRegistrar;
  readonly #moduleName: string;
  readonly #requiredPortIds: ReadonlySet<string>;

  constructor(app: RouteRegistrar, module: Module) {
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
