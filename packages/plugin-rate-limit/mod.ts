/** A bounded in-process fixed-window rate limiter for native HTTP handlers. @module */

type HttpHandler = (request: Request) => Response | Promise<Response>;

/** Rules used by the in-process fixed-window rate limiter. */
export interface RateLimitOptions {
  /** Requests permitted for one key during one time window. */
  readonly limit: number;
  /** Shared fixed-window duration in milliseconds. */
  readonly windowMs: number;
  /** Returns the trusted bucket key for one request. */
  readonly key: (request: Request) => string;
  /** Maximum active keys retained in memory. Defaults to 10,000. */
  readonly maxKeys?: number;
}

interface Bucket {
  readonly windowStart: number;
  used: number;
}

interface NormalizedOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly key: (request: Request) => string;
  readonly maxKeys: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * Adds a local fixed-window limit around a native HTTP handler.
 *
 * This wrapper is intentionally process-local. Use an edge service or a separate shared-store plugin
 * when limits must apply across multiple application instances.
 */
export function withRateLimit(next: HttpHandler, options: RateLimitOptions): HttpHandler {
  const policy = normalizeOptions(options);
  const buckets = new Map<string, Bucket>();

  return async (request) => {
    const now = Date.now();
    const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
    const resetAt = windowStart + policy.windowMs;
    const key = policy.key(request);
    if (key.length === 0) throw new TypeError("Rate-limit keys must not be empty.");

    let bucket = buckets.get(key);
    if (bucket?.windowStart !== windowStart) {
      if (bucket === undefined && buckets.size >= policy.maxKeys) {
        pruneExpired(buckets, windowStart);
      }
      if (bucket === undefined && buckets.size >= policy.maxKeys) {
        return rateLimited(policy.limit, 0, resetAt, now);
      }
      bucket = { windowStart, used: 0 };
      buckets.set(key, bucket);
    }

    if (bucket.used >= policy.limit) return rateLimited(policy.limit, 0, resetAt, now);

    bucket.used += 1;
    const response = await next(request);
    return withRateLimitHeaders(response, policy.limit, policy.limit - bucket.used, resetAt, now);
  };
}

function normalizeOptions(options: RateLimitOptions): NormalizedOptions {
  validatePositiveInteger(options.limit, "Rate-limit limit");
  validatePositiveInteger(options.windowMs, "Rate-limit windowMs");
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  validatePositiveInteger(maxKeys, "Rate-limit maxKeys");
  return { ...options, maxKeys };
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function pruneExpired(buckets: Map<string, Bucket>, windowStart: number): void {
  // ponytail: this is local memory only; use a shared-store plugin for distributed enforcement.
  for (const [key, bucket] of buckets) {
    if (bucket.windowStart !== windowStart) buckets.delete(key);
  }
}

function rateLimited(limit: number, remaining: number, resetAt: number, now: number): Response {
  const headers = rateLimitHeaders(limit, remaining, resetAt, now);
  headers.set("retry-after", String(secondsUntil(resetAt, now)));
  headers.set("content-type", "application/problem+json");
  return Response.json(
    {
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "RATE_LIMITED",
    },
    { status: 429, headers },
  );
}

function withRateLimitHeaders(
  response: Response,
  limit: number,
  remaining: number,
  resetAt: number,
  now: number,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of rateLimitHeaders(limit, remaining, resetAt, now)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rateLimitHeaders(limit: number, remaining: number, resetAt: number, now: number): Headers {
  return new Headers({
    "rateLimit-limit": String(limit),
    "rateLimit-remaining": String(remaining),
    "rateLimit-reset": String(secondsUntil(resetAt, now)),
  });
}

function secondsUntil(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1_000));
}
