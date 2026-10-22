import { node } from "@elysia/node";
import { Elysia } from "elysia";
import { replyBrand } from "./contract.ts";
import { HttpError, problemHandler, UnauthorizedError } from "./problem.ts";
import type {
  Application,
  ApplicationOptions,
  CloseOptions,
  ListenOptions,
  Listener,
  ModuleBuilder,
  ModuleDefinition,
  ProtectedModule,
  PublicModule,
  Reply,
  RootContainer,
  RouteApi,
  RouteDefinition,
  Schema,
} from "./contract.ts";
import { createListener } from "./listener.ts";
import { installOpenApi } from "./openapi.ts";
import { overlappingPaths, routePattern } from "./paths.ts";

/** Select a non-default success status declared in the route response map. */
export function reply<const Status extends number, Value>(
  status: Status,
  value: Value,
): Reply<Status, Value> {
  if (!Number.isInteger(status) || status < 200 || status >= 400)
    throw new RangeError("Reply status must be a 2xx or 3xx HTTP status.");
  return { status, value, [replyBrand]: true };
}

function routes<C extends RootContainer, I>(): RouteApi<C, I> {
  const method =
    (verb: RouteDefinition["method"]) => (path: string, options: RouteDefinition["options"]) => {
      if (!path.startsWith("/")) throw new Error(`Route path '${path}' must start with '/'.`);
      if (typeof options.handler !== "function")
        throw new Error(`Route '${path}' needs a handler.`);
      const response = options.response;
      const schemas = [
        options.params,
        options.query,
        options.body,
        ...(response ? ("~standard" in response ? [response] : Object.values(response)) : []),
      ];
      for (const schema of schemas) {
        if (schema && (schema as Schema)["~standard"]?.version !== 1)
          throw new Error(`Route '${path}' needs a Standard Schema v1 schema.`);
      }
      return { method: verb, path, options };
    };
  return {
    get: method("GET"),
    post: method("POST"),
    put: method("PUT"),
    patch: method("PATCH"),
    delete: method("DELETE"),
  } as RouteApi<C, I>;
}

/** Build routes once; the application owns the root container and supplied values. */
export function createApp<C extends RootContainer>(options: ApplicationOptions<C>): Application {
  const module: ModuleBuilder<C> = (<I>(definition: PublicModule<C> | ProtectedModule<C, I>) => {
    if (!definition.name || !definition.prefix.startsWith("/"))
      throw new Error("Modules need a name and an absolute path prefix.");
    const protectedModule =
      "authenticate" in definition && typeof definition.authenticate === "function";
    if (!protectedModule && "security" in definition)
      throw new Error(`Public module '${definition.name}' cannot declare security.`);
    return {
      name: definition.name,
      prefix: definition.prefix,
      routes: (definition.routes as ProtectedModule<C, I>["routes"])(routes<C, I>()),
      ...(protectedModule
        ? {
            authenticate: (request: Request) => definition.authenticate(request, options.container),
            ...(definition.security ? { security: definition.security } : {}),
          }
        : {}),
    };
  }) as ModuleBuilder<C>;
  const modules = options.modules({ module });
  const names = new Set<string>();
  const methods = new Set<string>();
  const declared: {
    method: string;
    path: string;
    authenticate?: ModuleDefinition["authenticate"];
  }[] = [];
  const authPolicies: {
    method: string;
    pattern: RegExp;
    authenticate(request: Request): unknown | Promise<unknown>;
  }[] = [];
  for (const entry of modules) {
    if (names.has(entry.name)) throw new Error(`Module '${entry.name}' is registered twice.`);
    names.add(entry.name);
    if (entry.prefix !== "/" && entry.prefix.endsWith("/"))
      throw new Error(`Module '${entry.name}' prefix cannot end in '/'.`);
    for (const route of entry.routes) {
      const path = `${entry.prefix === "/" ? "" : entry.prefix}${route.path}`;
      const key = `${route.method} ${path}`;
      if (methods.has(key)) throw new Error(`Route '${key}' is registered twice.`);
      methods.add(key);
      const pattern = routePattern(entry.prefix, route.path);
      for (const prior of declared) {
        if (
          prior.method === route.method &&
          prior.authenticate !== entry.authenticate &&
          overlappingPaths(prior.path, path)
        )
          throw new Error(
            `Overlapping routes '${prior.path}' and '${path}' have different authentication policies.`,
          );
      }
      declared.push({ method: route.method, path, authenticate: entry.authenticate });
      if (entry.authenticate)
        authPolicies.push({ method: route.method, pattern, authenticate: entry.authenticate });
    }
  }

  const identities = new WeakMap<Request, unknown>();
  // InferDI's generic input overload cannot express a dynamically authenticated module here.
  const scopedRoot = options.container as unknown as {
    createScope(inputs: { identity: unknown }): { dispose(): Promise<void> };
  };
  const pending = new Set<Promise<void>>();
  const completed = new WeakMap<Request, () => void>();
  const listeners = new Set<Listener>();
  let closing: Promise<void> | undefined;
  const app = new Elysia(process.versions.bun ? {} : { adapter: node() })
    .onError(problemHandler)
    .onRequest(async ({ request }) => {
      if (closing) throw new HttpError(503, "Application is closing.", "APPLICATION_UNAVAILABLE");
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(done);
      completed.set(request, () => {
        pending.delete(done);
        finish();
      });
      const path = authPolicies.length ? new URL(request.url).pathname : "";
      for (const policy of authPolicies) {
        if (
          (request.method !== policy.method &&
            !(request.method === "HEAD" && policy.method === "GET")) ||
          !policy.pattern.test(path)
        )
          continue;
        const identity = await policy.authenticate(request);
        if (identity == null) throw new UnauthorizedError();
        identities.set(request, identity);
        break;
      }
    })
    .onAfterResponse(({ request }) => {
      completed.get(request)?.();
      completed.delete(request);
      identities.delete(request);
    });

  for (const entry of modules) {
    app.group(entry.prefix, (group) => {
      for (const route of entry.routes) {
        const config = route.options;
        // Elysia validates only declared statuses, so an undeclared reply would bypass its schema.
        const declaredStatuses = !config.response
          ? undefined
          : "~standard" in config.response
            ? new Set([200])
            : new Set(Object.keys(config.response).map(Number));
        const detail = {
          ...(config.summary ? { summary: config.summary } : {}),
          ...(config.description ? { description: config.description } : {}),
          ...(config.tags ? { tags: [...config.tags] } : {}),
          ...(entry.security ? { security: [{ [entry.security]: [] }] } : {}),
        };
        group.route(
          route.method,
          route.path,
          async ({ request, params, query, body, set }) => {
            const identity = identities.get(request);
            let scope: { dispose(): Promise<void> } | undefined;
            const context = {
              request,
              root: options.container,
              identity,
              params,
              query,
              body,
              get scope() {
                if (!config.scoped) throw new Error("Route did not request a scope.");
                scope ??=
                  identity === undefined
                    ? options.container.createScope()
                    : scopedRoot.createScope({ identity });
                return scope;
              },
            } as Parameters<typeof config.handler>[0];
            try {
              await config.authorize?.(context);
              const result = await config.handler(context);
              if (result && typeof result === "object" && replyBrand in result) {
                const selected = result as Reply<number, unknown>;
                if (declaredStatuses && !declaredStatuses.has(selected.status))
                  throw new Error(`Route replied with undeclared status ${selected.status}.`);
                set.status = selected.status;
                return selected.value;
              }
              return result;
            } finally {
              await scope?.dispose();
            }
          },
          {
            ...(config.params ? { params: config.params } : {}),
            ...(config.query ? { query: config.query } : {}),
            ...(config.body ? { body: config.body } : {}),
            ...(config.response ? { response: config.response } : {}),
            detail,
          },
        );
      }
      return group;
    });
  }
  if (options.openapi) installOpenApi(app, options.openapi, modules);

  const fetch = (request: Request): Promise<Response> => {
    if (closing)
      return Promise.resolve(
        problemHandler({
          error: new HttpError(503, "Application is closing.", "APPLICATION_UNAVAILABLE"),
          code: "APPLICATION_UNAVAILABLE",
        }),
      );
    return app.handle(request);
  };
  return {
    fetch,
    async listen(settings: ListenOptions) {
      if (closing) throw new Error("Cannot listen after closing the application.");
      const listener = await createListener(app, settings);
      if (closing) {
        await listener.stop();
        throw new Error("Application closed during listen.");
      }
      listeners.add(listener);
      return listener;
    },
    close(settings?: CloseOptions) {
      const timeoutMs = settings?.timeoutMs;
      if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs >= 0))
        return Promise.reject(
          new RangeError("Close timeout must be a non-negative finite number."),
        );
      closing ??= (async () => {
        const stopped = await Promise.allSettled([...listeners].map((listener) => listener.stop()));
        await Promise.allSettled([...pending]);
        const failures = stopped.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) throw new AggregateError(failures, "Listener shutdown failed.");
      })();
      if (timeoutMs === undefined) return closing;
      // The deadline bounds only this caller's wait; handlers cannot be cancelled from here.
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Application close timed out.")), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
    },
  };
}
