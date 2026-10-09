import { type App, type AppEvent, createApp, createHealth, implement } from "@hyapi/core";
import { withCors } from "@hyapi/plugin-cors";
import { jwtBearer } from "@hyapi/plugin-jwt";
import { withRateLimit } from "@hyapi/plugin-rate-limit";
import { api } from "../contracts/api.ts";
import { system } from "../contracts/system.ts";
import { booksImplementation } from "./books.ts";
import { BookRepository } from "./repository.ts";

export interface ExampleConfig {
  /** The HS256 secret that librarian tokens are signed with; at least 32 bytes. */
  readonly jwtSecret: string;
  readonly development: boolean;
  /** Browser origins allowed to call the API. */
  readonly corsOrigins: readonly string[];
  /** Writes one JSON line per event; tests pass a collector instead. */
  readonly log?: (event: AppEvent) => void;
}

/** Logs request outcomes and problems as JSON lines. */
function jsonLog(event: AppEvent): void {
  if (event.type === "operation.start") return;
  console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
}

/**
 * Assembles the example: the app itself, and the handler to serve, which adds rate limiting and
 * CORS around `app.fetch`.
 */
export async function buildExample(config: ExampleConfig): Promise<{
  app: App;
  fetch: (request: Request) => Promise<Response>;
}> {
  const repository = new BookRepository();
  const health = createHealth({ catalog: () => repository.ping() });

  const app = await createApp({
    api,
    implementations: [
      booksImplementation(repository),
      implement(system, {
        health: async () => {
          const report = await health.check();
          return report.status === "unhealthy"
            ? { status: 503, body: report }
            : { status: 200, body: report };
        },
      }),
    ],
    verifiers: {
      bearer: await jwtBearer({
        algorithm: "HS256",
        key: config.jwtSecret,
        identity: (claims) => (claims.sub ? { subject: claims.sub } : null),
      }),
    },
    lifecycle: [{
      name: "catalog",
      start: () => repository.start(),
      stop: () => repository.stop(),
    }],
    development: config.development,
    onEvent: config.log ?? jsonLog,
    timeouts: { exportBooks: 60_000 },
  });

  const limited = withRateLimit(app.fetch, {
    limit: 600,
    windowMs: 60_000,
    // Behind a trusted proxy, limit by the forwarded client address.
    key: (request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
  });
  const fetch = withCors(limited, { origins: config.corsOrigins, maxAgeSeconds: 600 });
  return { app, fetch: async (request) => await fetch(request) };
}
