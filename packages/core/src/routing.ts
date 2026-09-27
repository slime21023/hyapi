import type {
  AnyRouteDefinition,
  AuthRequirement,
  LifecycleHook,
  ResponseSchemas,
  RouteDefinition,
  RouteGroupApi,
  RouteGroupOptions,
  Schema,
} from "./types.ts";
import { ConfigurationError } from "./errors.ts";

export type HookPoint = "onRequest" | "onResponse" | "onError";
export type RouteHooks = Readonly<Record<HookPoint, readonly LifecycleHook[]>>;

export function isProtectedAuth(
  auth: AuthRequirement | undefined,
): auth is Exclude<AuthRequirement, false> {
  return auth !== undefined && auth !== false;
}

export function resolveResponseSchemas(
  route: AnyRouteDefinition,
): Record<number, Schema | undefined> {
  if (route.responses) return route.responses;
  const defaultStatus = route.responseStatus ??
    (route.method === "post" ? 201 : route.method === "delete" ? 204 : 200);
  return { [defaultStatus]: undefined };
}

/** The narrow application boundary used by route groups. */
export interface RouteRegistrar {
  assertConfiguring(action: string): void;
  route<
    TParams extends Schema | undefined = undefined,
    TQuery extends Schema | undefined = undefined,
    TBody extends Schema | undefined = undefined,
    TResponse extends ResponseSchemas | undefined = undefined,
    TBodyRequired extends boolean = true,
  >(
    route: RouteDefinition<TParams, TQuery, TBody, TResponse, TBodyRequired>,
    scope?: RouterGroup,
  ): void;
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
