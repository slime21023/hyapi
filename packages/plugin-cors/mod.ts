/**
 * Cross-origin resource sharing as an outer `fetch` wrapper for HyAPI applications.
 *
 * ```ts
 * const handler = withCors(app.fetch, { origins: ["https://app.example.com"], credentials: true });
 * Deno.serve(handler);
 * ```
 *
 * Origins are always listed explicitly; there is no permissive default.
 *
 * @module
 */
import { problemResponse } from "@hyapi/core";

/** A Web-standard request handler, such as `app.fetch`. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Options for {@link withCors}. */
export interface CorsOptions {
  /**
   * Allowed origins, such as `["https://app.example.com"]`, or a predicate. `["*"]` allows any
   * origin, and cannot be combined with `credentials`.
   */
  readonly origins: readonly string[] | ((origin: string) => boolean);
  /** Methods allowed in preflight. Defaults to GET, HEAD, POST, PUT, PATCH, and DELETE. */
  readonly methods?: readonly string[];
  /** Request headers allowed in preflight. Defaults to `content-type` and `authorization`. */
  readonly allowHeaders?: readonly string[];
  /** Response headers that browsers may read. Defaults to none. */
  readonly exposeHeaders?: readonly string[];
  /** Allows cookies and authorization headers in cross-origin requests. Defaults to `false`. */
  readonly credentials?: boolean;
  /** How long browsers may cache a preflight answer. Defaults to 600 seconds. */
  readonly maxAgeSeconds?: number;
}

const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const DEFAULT_HEADERS = ["content-type", "authorization"];

function withVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (current === null) headers.set("vary", value);
  else if (!current.toLowerCase().split(/\s*,\s*/).includes(value.toLowerCase())) {
    headers.set("vary", `${current}, ${value}`);
  }
}

/**
 * Wraps a handler with CORS. Preflight requests from allowed origins are answered with 204;
 * preflight from other origins gets 403. Other requests reach the handler, and allowed origins
 * get CORS headers on the response.
 */
export function withCors(handler: FetchHandler, options: CorsOptions): FetchHandler {
  const wildcard = Array.isArray(options.origins) && options.origins.includes("*");
  if (wildcard && options.credentials === true) {
    throw new TypeError("credentials cannot be combined with the '*' origin");
  }
  if (Array.isArray(options.origins) && options.origins.length === 0) {
    throw new TypeError("origins must list at least one origin");
  }
  const allowed = typeof options.origins === "function"
    ? options.origins
    : (origin: string) => wildcard || (options.origins as readonly string[]).includes(origin);
  const methods = (options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase());
  const allowHeaders = (options.allowHeaders ?? DEFAULT_HEADERS).map((h) => h.toLowerCase());
  const exposeHeaders = options.exposeHeaders ?? [];
  const maxAge = options.maxAgeSeconds ?? 600;

  const decorate = (headers: Headers, origin: string) => {
    headers.set("access-control-allow-origin", wildcard ? "*" : origin);
    if (!wildcard) withVary(headers, "origin");
    if (options.credentials === true) headers.set("access-control-allow-credentials", "true");
  };

  return async (request) => {
    const origin = request.headers.get("origin");
    const requestedMethod = request.headers.get("access-control-request-method");
    if (request.method === "OPTIONS" && origin !== null && requestedMethod !== null) {
      if (!allowed(origin)) {
        return problemResponse(403, "CORS_ORIGIN_NOT_ALLOWED", {
          detail: `Origin ${origin} may not call this API.`,
        });
      }
      const requested = (request.headers.get("access-control-request-headers") ?? "")
        .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      if (
        !methods.includes(requestedMethod.toUpperCase()) ||
        requested.some((header) => !allowHeaders.includes(header))
      ) {
        return problemResponse(403, "CORS_REQUEST_NOT_ALLOWED", {
          detail: "The requested method or headers are not allowed cross-origin.",
        });
      }
      const headers = new Headers({
        "access-control-allow-methods": methods.join(", "),
        "access-control-allow-headers": allowHeaders.join(", "),
        "access-control-max-age": String(maxAge),
      });
      decorate(headers, origin);
      withVary(headers, "access-control-request-method");
      withVary(headers, "access-control-request-headers");
      return new Response(null, { status: 204, headers });
    }

    const response = await handler(request);
    if (origin === null || !allowed(origin)) return response;
    // Responses can have immutable headers, so the CORS headers go on a copy.
    const headers = new Headers(response.headers);
    decorate(headers, origin);
    if (exposeHeaders.length > 0) {
      headers.set("access-control-expose-headers", exposeHeaders.join(", "));
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
