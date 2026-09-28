/** Defines application health checks and their aggregated report. @module */

import type { MaybePromise } from "./types.ts";

/** Overall operational state reported by a health check or application. */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** A health check's own result; the registry assigns its public name. */
export interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly detail?: string | undefined;
}

/** Named asynchronous probe registered with an application. */
export interface HealthCheck {
  readonly name: string;
  check(): MaybePromise<HealthCheckResult>;
}

/** A health result associated with the registered check that supplied it. */
export interface HealthCheckReport extends HealthCheckResult {
  readonly name: string;
}

/** Aggregated health status and the result of every registered check. */
export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: readonly HealthCheckReport[];
}
