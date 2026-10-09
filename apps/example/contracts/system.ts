import { defineContract, HealthReport } from "@hyapi/core/contract";
import { security } from "./security.ts";

export const system = defineContract({
  securitySchemes: security,
  tags: ["system"],
  operations: {
    health: {
      method: "GET",
      path: "/health",
      summary: "Report readiness",
      description: "Answers 503 while a dependency is down or the server is shutting down.",
      security: [],
      responses: { 200: HealthReport, 503: HealthReport },
    },
  },
});
