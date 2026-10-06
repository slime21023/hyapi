/** Typed per-request state shared by hooks, guards, and handlers. @module */

import { ConfigurationError } from "./errors.ts";

/** Identifies one typed request-state value; keys compare by identity, not by name. */
export interface StateKey<T> {
  readonly name: string;
  readonly __type?: T;
}

/** Typed values shared by the hooks, guards, and handler of one request. */
export interface RequestState {
  get<T>(key: StateKey<T>): T | undefined;
  /** Returns the value, or throws a hidden configuration error when nothing set it. */
  require<T>(key: StateKey<T>): T;
  set<T>(key: StateKey<T>, value: T): void;
  has(key: StateKey<unknown>): boolean;
}

/**
 * Defines a typed request-state key.
 * @param name Diagnostic name; two keys with the same name remain distinct.
 */
export function defineStateKey<T>(name: string): StateKey<T> {
  return Object.freeze({ name });
}

export function createRequestState(): RequestState {
  const values = new Map<StateKey<unknown>, unknown>();
  return {
    get: <T>(key: StateKey<T>) => values.get(key) as T | undefined,
    require: <T>(key: StateKey<T>) => {
      if (!values.has(key)) {
        throw new ConfigurationError(`Request state '${key.name}' has not been set.`);
      }
      return values.get(key) as T;
    },
    set: (key, value) => void values.set(key, value),
    has: (key) => values.has(key),
  };
}
