import type { AppConfig } from "@hyapi/core";
import { buildExampleApp } from "./app.ts";

const config = loadConfig();
const app = await buildExampleApp(config, requiredEnv("JWT_SECRET"));

const controller = new AbortController();
const transmissions = new Set<Promise<void>>();
let notifyIdle: (() => void) | undefined;
const server = Deno.serve({
  hostname: config.host,
  port: config.port,
  signal: controller.signal,
}, (request, info) => {
  const completed = info.completed;
  transmissions.add(completed);
  const settled = () => {
    transmissions.delete(completed);
    if (transmissions.size === 0) notifyIdle?.();
  };
  void completed.then(settled, settled);
  return app.fetch(request);
});

let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  return stopping ??= (async () => {
    // Deno 2.9 can throw BadResource when aborting a server already in shutdown() with
    // an unfinished stream. Observe transport completion before starting server.shutdown().
    const closingApp = app.close();
    const deadline = Date.now() + 2 * (app.config.shutdownTimeoutMs ?? 30_000) + 1_000;
    const watchdog = new AbortController();
    const closingServer = (async () => {
      if (transmissions.size > 0) {
        const idle = new Promise<void>((resolve) => {
          notifyIdle = resolve;
          if (transmissions.size === 0) resolve();
        });
        await Promise.race([idle, abortAfter(deadline, watchdog.signal)]);
      }
      if (transmissions.size > 0) controller.abort();
      await server.shutdown();
      await server.finished;
    })();
    try {
      const results = await Promise.allSettled([closingApp, closingServer]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : []
      );
      if (errors.length > 1) throw new AggregateError(errors, "Server shutdown failed.");
      if (errors.length === 1) throw errors[0];
    } finally {
      watchdog.abort();
    }
  })();
}

async function abortAfter(deadline: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, Math.min(remaining, 2_147_483_647));
      function finish() {
        signal.removeEventListener("abort", finish);
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    void stop().catch(console.error);
  });
}
console.log(`HyAPI listening on http://${config.host}:${config.port}`);
try {
  await server.finished;
} finally {
  await stop();
}

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
    version: "1.0.0-rc.3",
    environment,
    requestIdHeader: "x-request-id",
    openapi: {
      enabled: true,
      defaultDocument: "default",
      documents: [{
        id: "default",
        title: "HyAPI Example API",
        description: "A structured TypeScript API running on Deno.",
        version: "1.0.0-rc.3",
        path: "/openapi.json",
      }],
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
