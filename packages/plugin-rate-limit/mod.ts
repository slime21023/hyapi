/**
 * Single-instance, in-memory rate limiting as an outer `fetch` wrapper for HyAPI applications.
 *
 * ```ts
 * const handler = withRateLimit(app.fetch, {
 *   limit: 100,
 *   windowMs: 60_000,
 *   key: (request) => request.headers.get("x-api-key") ?? undefined,
 * });
 * ```
 *
 * Counts live in this process only. With several instances, or for global limits, rate limit at
 * the edge or with a shared store in application code.
 *
 * @module
 */
import { problemResponse } from "@hyapi/core";

/** A Web-standard request handler, such as `app.fetch`. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Options for {@link withRateLimit}. */
export interface RateLimitOptions {
  /** Requests allowed per key and window. */
  readonly limit: number;
  /** The fixed window length in milliseconds. */
  readonly windowMs: number;
  /**
   * Identifies the caller, for example an API key or a client address forwarded by a trusted
   * proxy. Requests for which it returns `undefined` are not limited.
   */
  readonly key: (request: Request) => string | undefined;
  /** Maximum number of keys tracked at once; the oldest windows are dropped. Defaults to 10 000. */
  readonly maxKeys?: number;
}

interface Window {
  count: number;
  readonly resetAt: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

/** Makes room for a new window: expired windows go first, then the oldest ones. */
function evict(windows: Map<string, Window>, maxKeys: number, now: number): void {
  for (const [stored, window] of windows) if (window.resetAt <= now) windows.delete(stored);
  // Map keeps insertion order, so the first keys are the oldest windows.
  for (const stored of windows.keys()) {
    if (windows.size < maxKeys) return;
    windows.delete(stored);
  }
}

/**
 * Wraps a handler with a fixed-window rate limit per key. Every limited response carries
 * `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`; a rejected request gets 429 with
 * `Retry-After`.
 */
export function withRateLimit(handler: FetchHandler, options: RateLimitOptions): FetchHandler {
  positiveInteger(options.limit, "limit");
  positiveInteger(options.windowMs, "windowMs");
  const maxKeys = options.maxKeys ?? 10_000;
  positiveInteger(maxKeys, "maxKeys");
  const windows = new Map<string, Window>();

  const windowFor = (key: string, now: number): Window => {
    const existing = windows.get(key);
    if (existing !== undefined && existing.resetAt > now) return existing;
    windows.delete(key);
    if (windows.size >= maxKeys) evict(windows, maxKeys, now);
    const created = { count: 0, resetAt: now + options.windowMs };
    windows.set(key, created);
    return created;
  };

  return async (request) => {
    const key = options.key(request);
    if (key === undefined) return await handler(request);
    const now = Date.now();
    const window = windowFor(key, now);
    const resetSeconds = Math.max(0, Math.ceil((window.resetAt - now) / 1000));
    const limitHeaders = (remaining: number) => ({
      "ratelimit-limit": String(options.limit),
      "ratelimit-remaining": String(remaining),
      "ratelimit-reset": String(resetSeconds),
    });
    if (window.count >= options.limit) {
      return problemResponse(429, "RATE_LIMITED", {
        detail: `The limit of ${options.limit} requests per ${options.windowMs} ms is exhausted.`,
        headers: { ...limitHeaders(0), "retry-after": String(resetSeconds) },
      });
    }
    window.count++;
    const response = await handler(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(limitHeaders(options.limit - window.count))) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
