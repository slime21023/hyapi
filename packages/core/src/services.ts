import type {
  ServiceFactory,
  ServiceOverride,
  ServiceReference,
  ServiceResolver,
  ServiceScope,
} from "./types.ts";
import { ConfigurationError } from "./errors.ts";
import { type Scope, scopeClosedError } from "./scope.ts";

/** Request-scoped service instances and the scope that closes them when the request ends. */
export interface RequestServices {
  readonly scope: Scope;
  readonly cache: Map<ServiceReference<unknown>, Promise<unknown>>;
}

export class ServiceContainer {
  readonly #singletonScope: Scope;
  readonly #singletons = new Map<ServiceReference<unknown>, Promise<unknown>>();
  readonly #overrides = new Map<string, unknown>();

  constructor(singletonScope: Scope) {
    this.#singletonScope = singletonScope;
    // Registered first, so it runs last: the cache is dropped once every singleton has closed.
    singletonScope.defer(() => this.#singletons.clear());
  }

  setOverrides(overrides: readonly ServiceOverride[]): void {
    for (const override of overrides) {
      if (this.#overrides.has(override.name)) {
        throw new ConfigurationError(`Service override '${override.name}' is already registered.`);
      }
      this.#overrides.set(override.name, override.value);
    }
  }

  reference<T>(
    scope: ServiceScope,
    nameOrFactory: string | ServiceFactory<T>,
    maybeFactory?: ServiceFactory<T>,
  ): ServiceReference<T> {
    const name = typeof nameOrFactory === "string" ? nameOrFactory : undefined;
    const factory = typeof nameOrFactory === "function" ? nameOrFactory : maybeFactory;
    if (!factory) throw new ConfigurationError("A service factory is required.");
    return { ...(name ? { name } : {}), scope, factory };
  }

  resolver(requestServices?: RequestServices): ServiceResolver {
    return { get: <T>(service: ServiceReference<T>) => this.resolve(service, requestServices) };
  }

  resolve<T>(service: ServiceReference<T>, requestServices?: RequestServices): Promise<T> {
    if (service.name && this.#overrides.has(service.name)) {
      return Promise.resolve(this.#overrides.get(service.name) as T);
    }
    if (service.scope === "transient") return this.#create(service, requestServices);
    if (service.scope === "request" && !requestServices) {
      return Promise.reject(
        new ConfigurationError(
          "A request-scoped service cannot be resolved outside a request or from a singleton factory.",
        ),
      );
    }
    const owner = service.scope === "singleton" ? this.#singletonScope : requestServices!.scope;
    if (owner.state !== "open") return Promise.reject(scopeClosedError());
    const cache = service.scope === "singleton" ? this.#singletons : requestServices!.cache;
    const key = service as ServiceReference<unknown>;
    const existing = cache.get(key);
    if (existing) return existing as Promise<T>;
    const created = this.#create(service, requestServices);
    cache.set(key, created);
    // A failed factory must not poison the cache; the next resolution retries it.
    created.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
    return created;
  }

  async #create<T>(service: ServiceReference<T>, requestServices?: RequestServices): Promise<T> {
    const value = await service.factory(
      this.resolver(service.scope === "singleton" ? undefined : requestServices),
    );
    if (service.scope === "singleton") return await this.#singletonScope.adopt(value);
    if (service.scope === "request") return await requestServices!.scope.adopt(value);
    return value;
  }
}
