/** CORS handling for native Deno and Web Platform HTTP handlers. @module */

type HttpHandler = (request: Request) => Response | Promise<Response>;

/** A literal browser Origin or a regular expression that matches one. */
export type CorsOrigin = string | RegExp;

/** Explicit CORS rules applied around one HTTP handler. */
export interface CorsOptions {
  /** Origins allowed to read responses. `"*"` allows every non-credentialed origin. */
  readonly origins: "*" | readonly CorsOrigin[];
  /** Methods permitted for browser preflight requests. */
  readonly methods: readonly string[];
  /** Non-simple request headers permitted for browser preflight requests. */
  readonly headers?: readonly string[];
  /** Response headers JavaScript callers may read. */
  readonly exposeHeaders?: readonly string[];
  /** Browser preflight cache duration in seconds. */
  readonly maxAgeSeconds?: number;
  /** Whether browsers may include credentials in allowed cross-origin requests. */
  readonly credentials?: boolean;
}

interface NormalizedCorsOptions {
  readonly origins: "*" | readonly CorsOrigin[];
  readonly methods: ReadonlySet<string>;
  readonly methodList: readonly string[];
  readonly headers: ReadonlySet<string>;
  readonly headerList: readonly string[];
  readonly exposeHeaders: readonly string[];
  readonly maxAgeSeconds: number | undefined;
  readonly credentials: boolean;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Adds explicit CORS handling around a native HTTP handler.
 *
 * The wrapper handles accepted preflight requests itself and adds CORS response headers after the
 * wrapped handler finishes. It does not authenticate or reject ordinary requests from untrusted origins.
 */
export function withCors(next: HttpHandler, options: CorsOptions): HttpHandler {
  const policy = normalizeOptions(options);

  return async (request) => {
    const origin = request.headers.get("origin");
    if (origin === null) return await next(request);

    const allowed = allowsOrigin(policy, origin);
    if (isPreflight(request)) {
      if (!allowed || !allowsPreflight(policy, request)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(policy, origin, true) });
    }

    const response = await next(request);
    return allowed
      ? withHeaders(response, corsHeaders(policy, origin, false))
      : withoutCorsHeaders(response);
  };
}

function normalizeOptions(options: CorsOptions): NormalizedCorsOptions {
  const credentials = options.credentials ?? false;
  if (options.origins === "*" && credentials) {
    throw new TypeError("CORS credentials require explicit literal origins.");
  }

  const origins = options.origins === "*" ? "*" : normalizeOrigins(options.origins, credentials);
  const methodList = normalizeTokenList(
    options.methods,
    "CORS methods",
    (value) => value.toUpperCase(),
  );
  if (methodList.length === 0) throw new TypeError("CORS methods must not be empty.");
  const headerList = normalizeTokenList(
    options.headers ?? [],
    "CORS headers",
    (value) => value.toLowerCase(),
  );
  return {
    origins,
    methods: new Set(methodList),
    methodList,
    headers: new Set(headerList),
    headerList,
    exposeHeaders: normalizeTokenList(
      options.exposeHeaders ?? [],
      "CORS exposed headers",
      (value) => value,
    ),
    maxAgeSeconds: normalizeMaxAge(options.maxAgeSeconds),
    credentials,
  };
}

function normalizeOrigins(
  origins: readonly CorsOrigin[],
  credentials: boolean,
): readonly CorsOrigin[] {
  if (origins.length === 0) throw new TypeError("CORS origins must not be empty.");
  if (credentials && origins.some((origin) => origin instanceof RegExp)) {
    throw new TypeError("CORS credentials require literal origins.");
  }

  return origins.map((origin) => {
    if (origin instanceof RegExp) return origin;
    if (origin === "*") throw new TypeError('Use origins: "*" to allow every origin.');
    if (origin === "null") return origin;

    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("CORS literal origins must use HTTP or HTTPS.");
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new TypeError("CORS literal origins must not include a path, query, or hash.");
    }
    return url.origin;
  });
}

function normalizeTokenList(
  values: readonly string[],
  label: string,
  transform: (value: string) => string,
): readonly string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (!TOKEN.test(value)) throw new TypeError(`${label} must contain HTTP tokens.`);
    result.add(transform(value));
  }
  return [...result];
}

function normalizeMaxAge(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("CORS maxAgeSeconds must be a non-negative integer.");
  }
  return value;
}

function allowsOrigin(options: NormalizedCorsOptions, origin: string): boolean {
  if (options.origins === "*") return true;
  return options.origins.some((rule) => {
    if (typeof rule === "string") return rule === origin;
    rule.lastIndex = 0;
    const matches = rule.test(origin);
    rule.lastIndex = 0;
    return matches;
  });
}

function isPreflight(request: Request): boolean {
  return request.method === "OPTIONS" && request.headers.has("access-control-request-method");
}

function allowsPreflight(options: NormalizedCorsOptions, request: Request): boolean {
  const method = request.headers.get("access-control-request-method");
  if (method === null || !options.methods.has(method.toUpperCase())) return false;

  const headers = request.headers.get("access-control-request-headers");
  return headers === null || headers.split(",").every((header) => {
    const normalized = header.trim().toLowerCase();
    return normalized.length > 0 && options.headers.has(normalized);
  });
}

function corsHeaders(options: NormalizedCorsOptions, origin: string, preflight: boolean): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", options.origins === "*" ? "*" : origin);
  if (options.origins !== "*") addVary(headers, ["origin"]);
  if (options.credentials) headers.set("access-control-allow-credentials", "true");

  if (!preflight) {
    if (options.exposeHeaders.length > 0) {
      headers.set("access-control-expose-headers", options.exposeHeaders.join(", "));
    }
    return headers;
  }

  headers.set("access-control-allow-methods", options.methodList.join(", "));
  if (options.headerList.length > 0) {
    headers.set("access-control-allow-headers", options.headerList.join(", "));
  }
  if (options.maxAgeSeconds !== undefined) {
    headers.set("access-control-max-age", String(options.maxAgeSeconds));
  }
  addVary(headers, ["origin", "access-control-request-method", "access-control-request-headers"]);
  return headers;
}

function withHeaders(response: Response, added: Headers): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of added) {
    if (name === "vary") addVary(headers, value.split(","));
    else headers.set(name, value);
  }
  return copyResponse(response, headers);
}

function withoutCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (
    const name of [
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-expose-headers",
    ]
  ) {
    headers.delete(name);
  }
  return copyResponse(response, headers);
}

function copyResponse(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function addVary(headers: Headers, names: readonly string[]): void {
  const current = headers.get("vary");
  if (current === "*") return;

  const values = new Map<string, string>();
  for (const value of (current ?? "").split(",").concat([...names])) {
    const trimmed = value.trim();
    if (trimmed) values.set(trimmed.toLowerCase(), trimmed);
  }
  headers.set("vary", [...values.values()].join(", "));
}
