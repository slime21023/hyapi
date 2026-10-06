/** Matches requests to route handlers. The only Core module that depends on Hono. @module */

import { Hono } from "@hono/hono";
import type { HttpRequestScope } from "./lifecycle.ts";

type RouterEnv = { Bindings: { scope: HttpRequestScope } };

/** Handles a matched request with its decoded path parameters. */
export type MatchedRouteHandler = (
  scope: HttpRequestScope,
  params: Record<string, string>,
) => Response | Promise<Response>;

/** Answers requests the router cannot hand to a route handler. */
export interface RouterFallbacks {
  /** Answers a request that matched no route. */
  notFound(scope: HttpRequestScope): Response | Promise<Response>;
  /** Answers a failure thrown while dispatching, outside a route handler's own handling. */
  error(scope: HttpRequestScope, error: unknown): Response | Promise<Response>;
}

/** Converts `{name}` path parameters to the router's `:name` syntax. */
function routerPath(path: string): string {
  return path.replace(/\{([^}/]+)\}/g, ":$1");
}

export class Router {
  readonly #hono = new Hono<RouterEnv>();

  constructor(fallbacks: RouterFallbacks) {
    this.#hono.notFound((context) => fallbacks.notFound(context.env.scope));
    this.#hono.onError((error, context) => fallbacks.error(context.env.scope, error));
  }

  /** Registers `handler` for an uppercase HTTP method and a `{name}`-style path. */
  add(method: string, path: string, handler: MatchedRouteHandler): void {
    this.#hono.on(
      method,
      routerPath(path),
      (context) => handler(context.env.scope, context.req.param() as Record<string, string>),
    );
  }

  async dispatch(request: Request, scope: HttpRequestScope): Promise<Response> {
    return await this.#hono.fetch(request, { scope });
  }
}
