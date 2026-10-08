import { serve } from "@hyapi/core/deno";
import { buildExample } from "./app.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const { app, fetch } = await buildExample({
  jwtSecret: requiredEnv("JWT_SECRET"),
  development: Deno.env.get("APP_ENV") !== "production",
  corsOrigins: (Deno.env.get("CORS_ORIGINS") ?? "http://localhost:5173").split(","),
});

// Serves the wrapped handler and closes the app gracefully on SIGINT/SIGTERM.
const server = serve(app, { port: Number(Deno.env.get("PORT") ?? 8000), fetch });
await server.finished;
