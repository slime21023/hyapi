import type { AppConfig } from "@hyapi/core";
import { buildExampleApp } from "./app.ts";

const config = loadConfig();
const app = await buildExampleApp(config, requiredEnv("JWT_SECRET"));

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => controller.abort());
}
const server = Deno.serve({
  hostname: config.host,
  port: config.port,
  signal: controller.signal,
}, app.fetch.bind(app));

console.log(`HyAPI listening on http://${config.host}:${config.port}`);
await server.finished;

function loadConfig(): AppConfig & { host: string; port: number } {
  const environment = Deno.env.get("DENO_ENV") ?? "development";
  if (environment !== "development" && environment !== "test" && environment !== "production") {
    throw new Error("DENO_ENV must be development, test, or production.");
  }
  const port = Number(Deno.env.get("PORT") ?? "8000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return {
    name: "hyapi-example",
    version: "0.1.0",
    environment,
    requestIdHeader: "x-request-id",
    openapi: {
      title: "HyAPI Example API",
      description: "A structured TypeScript API running on Deno.",
      version: "0.1.0",
      path: "/openapi.json",
    },
    host: Deno.env.get("HOST") ?? "127.0.0.1",
    port,
  };
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}
