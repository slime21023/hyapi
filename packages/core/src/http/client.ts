/** Provides a small native-fetch HTTP client and request-context propagation. @module */

import { ConfigurationError } from "../errors.ts";
import type { HealthCheck } from "../health.ts";
import { MAX_TIMER_MS } from "../runtime/timers.ts";
import type { MaybePromise } from "../types.ts";
import { DEADLINE_HEADER } from "./deadline.ts";

/** Client that resolves absolute contract paths against one base URL. */
export interface HttpClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** Base URL and optional native-compatible fetch implementation for an HTTP client. */
export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => MaybePromise<Response>;
}

/** Request values propagated to an outbound HTTP call. */
export interface HttpPropagationSource {
  readonly request: Request;
  readonly requestId: string;
  readonly requestIdHeader?: string;
  readonly deadline?: number;
}

/** Endpoint and timeout used to build an HTTP-backed health check. */
export interface HttpHealthCheckOptions extends HttpClientOptions {
  readonly name: string;
  readonly path: string;
  readonly timeoutMs: number;
}

/** Creates an HTTP client that preserves the base URL's path prefix. */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const baseUrl = new URL(options.baseUrl);
  const request = options.fetch ?? globalThis.fetch;
  return {
    fetch: async (path, init) => await request(resolveHttpUrl(baseUrl, path), init),
  };
}

/** Adds request ID, tracing, service, and deadline headers to an outbound request. */
export function withHttpContext(
  source: HttpPropagationSource,
  serviceName: string,
  init: RequestInit = {},
): RequestInit {
  if (!serviceName.trim()) throw new Error("HTTP serviceName must not be empty.");
  const headers = new Headers(init.headers);
  headers.set(source.requestIdHeader ?? "x-request-id", source.requestId);
  const traceparent = source.request.headers.get("traceparent");
  if (traceparent) headers.set("traceparent", traceparent);
  headers.set("x-hyapi-service", serviceName);
  if (source.deadline !== undefined && Number.isFinite(source.deadline)) {
    headers.set(DEADLINE_HEADER, String(Math.floor(source.deadline)));
  }
  return { ...init, headers };
}

/** Creates a GET health probe that classifies non-success responses as unhealthy. */
export function createHttpHealthCheck(options: HttpHealthCheckOptions): HealthCheck {
  if (!options.path.startsWith("/")) {
    throw new ConfigurationError(`HTTP health check '${options.name}' path must start with '/'.`);
  }
  if (
    !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMER_MS
  ) {
    throw new ConfigurationError(
      "HTTP health checks require a positive timeoutMs of at most 2147483647.",
    );
  }
  const client = createHttpClient(options);
  return {
    name: options.name,
    check: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await client.fetch(options.path, {
          method: "GET",
          signal: controller.signal,
        });
        await response.body?.cancel().catch(() => undefined);
        return response.ok ? { status: "healthy" } : {
          status: "unhealthy",
          detail: `Health endpoint returned ${response.status}.`,
        };
      } catch (error) {
        return {
          status: "unhealthy",
          detail: error instanceof Error ? error.message : "Health endpoint request failed.",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function resolveHttpUrl(baseUrl: URL, path: string): URL {
  if (!path.startsWith("/")) throw new ConfigurationError("HTTP client paths must start with '/'.");
  const target = new URL(path, "http://hyapi.invalid");
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${target.pathname}`;
  url.search = target.search;
  url.hash = target.hash;
  return url;
}
