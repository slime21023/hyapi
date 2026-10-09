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

/** CORS options with every default applied. */
interface Cors {
  readonly wildcard: boolean;
  readonly allowed: (origin: string) => boolean;
  readonly methods: readonly string[];
  readonly allowHeaders: readonly string[];
  readonly exposeHeaders: readonly string[];
  readonly credentials: boolean;
  readonly maxAge: number;
}

function resolveOptions(options: CorsOptions): Cors {
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
  return {
    wildcard,
    allowed,
    methods: (options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()),
    allowHeaders: (options.allowHeaders ?? DEFAULT_HEADERS).map((h) => h.toLowerCase()),
    exposeHeaders: options.exposeHeaders ?? [],
    credentials: options.credentials === true,
    maxAge: options.maxAgeSeconds ?? 600,
  };
}

/** A copy of a response with other headers; response headers can be immutable. */
function withHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function varyByOrigin(response: Response, cors: Cors): Response {
  if (cors.wildcard) return response;
  const headers = new Headers(response.headers);
  withVary(headers, "origin");
  return withHeaders(response, headers);
}

function allowOrigin(headers: Headers, origin: string, cors: Cors): void {
  headers.set("access-control-allow-origin", cors.wildcard ? "*" : origin);
  if (!cors.wildcard) withVary(headers, "origin");
  if (cors.credentials) headers.set("access-control-allow-credentials", "true");
}

/** Answers a preflight request: 204 when everything requested is allowed, otherwise 403. */
function answerPreflight(request: Request, origin: string, method: string, cors: Cors): Response {
  if (!cors.allowed(origin)) {
    const refused = problemResponse(403, "CORS_ORIGIN_NOT_ALLOWED", {
      detail: `Origin ${origin} may not call this API.`,
    });
    return varyByOrigin(refused, cors);
  }
  const requested = (request.headers.get("access-control-request-headers") ?? "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (
    !cors.methods.includes(method.toUpperCase()) ||
    requested.some((header) => !cors.allowHeaders.includes(header))
  ) {
    return problemResponse(403, "CORS_REQUEST_NOT_ALLOWED", {
      detail: "The requested method or headers are not allowed cross-origin.",
    });
  }
  const headers = new Headers({
    "access-control-allow-methods": cors.methods.join(", "),
    "access-control-allow-headers": cors.allowHeaders.join(", "),
    "access-control-max-age": String(cors.maxAge),
  });
  allowOrigin(headers, origin, cors);
  withVary(headers, "access-control-request-method");
  withVary(headers, "access-control-request-headers");
  return new Response(null, { status: 204, headers });
}

/** Adds CORS headers to a response for an allowed origin; any response varies by origin. */
function addCorsHeaders(response: Response, origin: string | null, cors: Cors): Response {
  if (origin === null || !cors.allowed(origin)) return varyByOrigin(response, cors);
  const headers = new Headers(response.headers);
  allowOrigin(headers, origin, cors);
  if (cors.exposeHeaders.length > 0) {
    headers.set("access-control-expose-headers", cors.exposeHeaders.join(", "));
  }
  return withHeaders(response, headers);
}

/**
 * Wraps a handler with CORS. Preflight requests from allowed origins are answered with 204;
 * preflight from other origins gets 403. Other requests reach the handler, and allowed origins
 * get CORS headers on the response. Unless the origin is `*`, every response varies by `Origin`,
 * so a shared cache never serves one origin's answer to another.
 */
export function withCors(handler: FetchHandler, options: CorsOptions): FetchHandler {
  const cors = resolveOptions(options);
  return async (request) => {
    const origin = request.headers.get("origin");
    const method = request.headers.get("access-control-request-method");
    if (request.method === "OPTIONS" && origin !== null && method !== null) {
      return answerPreflight(request, origin, method, cors);
    }
    return addCorsHeaders(await handler(request), origin, cors);
  };
}
