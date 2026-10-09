import type { Static } from "typebox";
import type { HealthReport } from "../contract/schema.ts";
import { withDeadline } from "./deadline.ts";

type Awaitable<T> = T | Promise<T>;

/** The status of one check, or of the whole report. */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/**
 * One health check. Resolving (with nothing) means healthy; returning `{ status: "degraded" }`
 * reports degradation; throwing or rejecting means unhealthy. Checks receive a signal that aborts
 * at the check timeout.
 */
export type HealthCheck = (
  signal: AbortSignal,
) => Awaitable<void | { readonly status: "healthy" | "degraded"; readonly detail?: string }>;

/** A health report; its schema is `HealthReport` in `@hyapi/core/contract`. */
export type HealthReportValue = Static<typeof HealthReport>;

/** Health checks aggregated into one report. */
export interface Health {
  /** Runs every check concurrently and aggregates the results. */
  check(): Promise<HealthReportValue>;
}

/**
 * Creates a health aggregator. The overall status is the worst check status. A closing
 * application answers every new request with 503, so the health operation needs no draining
 * state of its own.
 *
 * @example
 * ```ts
 * const health = createHealth({ database: (signal) => pool.ping({ signal }) });
 * // In the handler of a declared health operation:
 * const report = await health.check();
 * return { status: report.status === "unhealthy" ? 503 : 200, body: report };
 * ```
 */
export function createHealth(
  checks: Readonly<Record<string, HealthCheck>>,
  options: { readonly timeoutMs?: number } = {},
): Health {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive integer");
  }
  for (const [name, check] of Object.entries(checks)) {
    if (typeof check !== "function") {
      throw new TypeError(`health check '${name}' must be a function`);
    }
  }
  return Object.freeze({
    async check() {
      const results = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
          const started = performance.now();
          let status: HealthStatus;
          let detail: string | undefined;
          try {
            const result = await withDeadline(check, timeoutMs);
            status = result?.status ?? "healthy";
            detail = result?.detail;
          } catch (error) {
            status = "unhealthy";
            detail = error instanceof Error ? error.message : String(error);
          }
          const durationMs = Math.round((performance.now() - started) * 100) / 100;
          return [name, {
            status,
            durationMs,
            ...(detail === undefined ? {} : { detail }),
          }] as const;
        }),
      );
      const statuses = results.map(([, result]) => result.status);
      const status: HealthStatus = statuses.includes("unhealthy")
        ? "unhealthy"
        : statuses.includes("degraded")
        ? "degraded"
        : "healthy";
      return { status, checks: Object.fromEntries(results) };
    },
  });
}
