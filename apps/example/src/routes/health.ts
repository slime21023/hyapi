import { defineRoute, type RouteGroupApi } from "@hyapi/core";
import { HealthResponseSchema, ReadyResponseSchema } from "../schemas.ts";

export function registerHealthRoutes(api: RouteGroupApi, serviceName: string): void {
  api.group("/health", { tags: ["health"] }, (health) => {
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
        responses: { 200: ReadyResponseSchema },
        metadata: { operationId: "healthReady", summary: "Readiness probe" },
        handler: ({ ok }) =>
          ok({
            status: "ready" as const,
            service: serviceName,
            timestamp: new Date().toISOString(),
          }),
      }),
    );
  });
}
