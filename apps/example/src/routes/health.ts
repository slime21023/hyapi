import { defineRoute } from "@hyapi/core";
import { HealthResponseSchema, ReadyResponseSchema } from "../schemas.ts";

export function healthRoutes(serviceName: string) {
  return [
    defineRoute({
      method: "get",
      path: "/health/live",
      response: HealthResponseSchema,
      metadata: { operationId: "healthLive", summary: "Liveness probe", tags: ["health"] },
      handler: () => ({
        status: "ok" as const,
        service: serviceName,
        timestamp: new Date().toISOString(),
      }),
    }),
    defineRoute({
      method: "get",
      path: "/health/ready",
      response: ReadyResponseSchema,
      metadata: { operationId: "healthReady", summary: "Readiness probe", tags: ["health"] },
      handler: () => ({
        status: "ready" as const,
        service: serviceName,
        timestamp: new Date().toISOString(),
      }),
    }),
  ];
}
