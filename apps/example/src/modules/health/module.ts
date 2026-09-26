import { defineModule, defineRoute, type HealthReport, type Module } from "@hyapi/core";
import { HealthResponseSchema, NotReadyResponseSchema, ReadyResponseSchema } from "./schema.ts";

export function createHealthModule(
  serviceName: string,
  readiness: () => Promise<HealthReport>,
): Module {
  return defineModule({
    name: "health",
    setup(module) {
      module.group("/health", { tags: ["health"] }, (health) => {
        health.route(
          defineRoute({
            method: "get",
            path: "/live",
            responses: { 200: HealthResponseSchema },
            metadata: { operationId: "healthLive", summary: "Liveness probe" },
            handler: ({ ok }) =>
              ok({
                status: "ok" as const,
                service: serviceName,
                timestamp: new Date().toISOString(),
              }),
          }),
        );
        health.route(
          defineRoute({
            method: "get",
            path: "/ready",
            responses: { 200: ReadyResponseSchema, 503: NotReadyResponseSchema },
            metadata: { operationId: "healthReady", summary: "Readiness probe" },
            handler: async ({ ok, json }) => {
              const report = await readiness();
              const timestamp = new Date().toISOString();
              if (report.status === "unhealthy") {
                return json({
                  status: "unavailable" as const,
                  service: serviceName,
                  timestamp,
                  providers: [...report.providers],
                }, 503);
              }
              return ok({ status: "ready" as const, service: serviceName, timestamp });
            },
          }),
        );
      });
    },
  });
}
