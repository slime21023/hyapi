import { ConfigurationError } from "../errors.ts";
import type { HealthCheck, HealthCheckReport, HealthCheckResult, HealthReport } from "../health.ts";

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

function isHealthCheckResult(value: unknown): value is HealthCheckResult {
  if (typeof value !== "object" || value === null || !("status" in value)) return false;
  const detail = "detail" in value ? value.detail : undefined;
  return (value.status === "healthy" || value.status === "degraded" ||
    value.status === "unhealthy") && (detail === undefined || typeof detail === "string");
}

/** Runs application health checks without exposing their implementation details in public reports. */
export class HealthRegistry {
  readonly #checks = new Map<string, HealthCheck>();

  register(checks: readonly HealthCheck[]): void {
    for (const check of checks) {
      if (typeof check.name !== "string" || check.name.trim() === "") {
        throw new ConfigurationError("Health check names must be non-empty strings.");
      }
      if (this.#checks.has(check.name)) {
        throw new ConfigurationError(`Health check '${check.name}' is already registered.`);
      }
      this.#checks.set(check.name, check);
    }
  }

  async check(): Promise<HealthReport> {
    const checks = await Promise.all([...this.#checks.values()].map((check) => this.#run(check)));
    const status = checks.some((check) => check.status === "unhealthy")
      ? "unhealthy"
      : checks.some((check) => check.status === "degraded")
      ? "degraded"
      : "healthy";
    return { status, checks };
  }

  async #run(check: HealthCheck): Promise<HealthCheckReport> {
    const { promise: timedOut, resolve } = Promise.withResolvers<HealthCheckReport>();
    const timer = setTimeout(() =>
      resolve({
        status: "unhealthy",
        name: check.name,
        detail: `Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS} ms.`,
      }), HEALTH_CHECK_TIMEOUT_MS);
    try {
      const result: unknown = await Promise.race([
        Promise.resolve().then(() => check.check()),
        timedOut,
      ]);
      if (!isHealthCheckResult(result)) {
        return {
          status: "unhealthy",
          name: check.name,
          detail: "Health check returned an invalid result.",
        };
      }
      return {
        status: result.status,
        name: check.name,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
    } catch (error) {
      return {
        status: "unhealthy",
        name: check.name,
        detail: error instanceof Error ? error.message : "Health check failed.",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
