import type {
  AnyRouteDefinition,
  LifecycleHook,
  ResponseSchemas,
  RouteDefinition,
  RouteGroupApi,
  RouteGroupOptions,
  Schema,
} from "./types.ts";

export type HookPoint = "onRequest" | "onResponse" | "onError";
export type RouteHooks = Readonly<Record<HookPoint, readonly LifecycleHook[]>>;

/** `responseStatus` wins; otherwise no body is 204, a POST body is 201, and any other body is 200. */
export function defaultResponseStatus(route: AnyRouteDefinition, body: unknown): number {
  if (route.responseStatus !== undefined) return route.responseStatus;
  if (body === undefined) return 204;
  return route.method === "post" ? 201 : 200;
}

export function resolveResponseSchemas(
  route: AnyRouteDefinition,
): Record<number, Schema | undefined> {
  if (route.responses) return route.responses;
  if (route.responseStatus !== undefined) return { [route.responseStatus]: undefined };
  if (route.method === "post") return { 201: undefined };
  // Without declared responses, the status depends on whether the handler returns a body.
  if (route.method === "delete") return { 200: undefined, 204: undefined };
  return { 200: undefined };
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
    const guards = [...(this.#options.guards ?? []), ...(route.guards ?? [])];

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
      ...(guards.length > 0 ? { guards } : {}),
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
    const mergedGuards = [...(this.#options.guards ?? []), ...(childOpts.guards ?? [])];

    const newOpts: RouteGroupOptions = {};
    if (mergedPrefix) newOpts.prefix = mergedPrefix;
    if (mergedTags.length > 0) newOpts.tags = mergedTags;
    if (mergedGuards.length > 0) newOpts.guards = mergedGuards;

    fn(new RouterGroup(this.#app, newOpts, this));
  }
}
