/** Guards authenticate and authorize a route before its input is parsed. @module */

import { ConfigurationError, ForbiddenError, UnauthorizedError } from "./errors.ts";
import type { RequestState } from "./state.ts";
import type { Identity, MaybePromise } from "./types.ts";

/** Request values available to a guard; input has not been parsed or validated yet. */
export interface GuardContext {
  readonly request: Request;
  readonly requestId: string;
  /** Raw route parameters, before schema validation. */
  readonly params: Readonly<Record<string, string>>;
  /** Raw query values, before schema validation. */
  readonly query: Readonly<Record<string, string | string[]>>;
  /** Identity established by an earlier guard, if any. */
  readonly identity: Identity | null;
  readonly state: RequestState;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

/** OpenAPI metadata a guard contributes to the routes it protects. */
export interface GuardSecurity {
  /** OpenAPI security schemes, keyed by scheme name. */
  readonly schemes?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Scopes this guard requires; an empty list still requires an identity. */
  readonly scopes?: readonly string[];
  /** The guard admits requests that carry no credentials. */
  readonly optional?: boolean;
  /** Alternative guards, any one of which is sufficient. Set by {@link anyOf}. */
  readonly alternatives?: readonly Guard[];
}

/**
 * Authenticates or authorizes a request. Return an identity to establish it, return nothing to
 * pass without one, or throw an `AppError` (normally 401 or 403) to reject the request.
 * Guards must not read the request body.
 */
export interface Guard {
  readonly name: string;
  readonly security?: GuardSecurity;
  check(context: GuardContext): MaybePromise<Identity | void>;
}

/** Validates and freezes a guard. */
export function defineGuard(guard: Guard): Guard {
  if (typeof guard.name !== "string" || guard.name.trim() === "") {
    throw new ConfigurationError("Guard names must be non-empty strings.");
  }
  if (typeof guard.check !== "function") {
    throw new ConfigurationError(`Guard '${guard.name}' must define a check function.`);
  }
  return Object.freeze({ ...guard });
}

/**
 * Passes when any guard passes, trying them in order and keeping the first result.
 * When every guard rejects, the first rejection is rethrown.
 */
export function anyOf(...guards: readonly Guard[]): Guard {
  if (guards.length === 0) throw new ConfigurationError("anyOf() requires at least one guard.");
  return defineGuard({
    name: `anyOf(${guards.map((guard) => guard.name).join(", ")})`,
    security: { alternatives: guards },
    async check(context) {
      let firstError: unknown;
      for (const guard of guards) {
        try {
          return await guard.check(context);
        } catch (error) {
          firstError ??= error;
        }
      }
      throw firstError;
    },
  });
}

/** Requires an identity (401 otherwise) that holds every listed scope (403 otherwise). */
export function requireScopes(...scopes: readonly string[]): Guard {
  return defineGuard({
    name: `requireScopes(${scopes.join(", ")})`,
    security: { scopes },
    check({ identity }) {
      if (!identity) throw new UnauthorizedError();
      if (!scopes.every((scope) => identity.scopes.includes(scope))) throw new ForbiddenError();
    },
  });
}

export function isIdentity(value: unknown): value is Identity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Identity>;
  return typeof candidate.subject === "string" && candidate.subject.length > 0 &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every((scope) => typeof scope === "string") &&
    typeof candidate.claims === "object" && candidate.claims !== null;
}
