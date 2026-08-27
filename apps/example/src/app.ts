import { type AppConfig, createApp, type HyApiApp, jwtPlugin } from "@hyapi/core";
import { healthRoutes } from "./routes/health.ts";
import { userRoutes } from "./routes/users.ts";
import { InMemoryUserRepository } from "./repositories/user-repository.ts";
import { UserService } from "./services/user-service.ts";

export interface ExampleAppOptions {
  readonly enableRequestLogging?: boolean;
}

export async function buildExampleApp(
  config: AppConfig,
  jwtSecret: string,
  options: ExampleAppOptions = {},
): Promise<HyApiApp> {
  const app = createApp({ config });
  await app.register(jwtPlugin(), {
    secret: jwtSecret,
    ...(Deno.env.get("JWT_ISSUER") ? { issuer: Deno.env.get("JWT_ISSUER")! } : {}),
    ...(Deno.env.get("JWT_AUDIENCE") ? { audience: Deno.env.get("JWT_AUDIENCE")! } : {}),
  });

  if (options.enableRequestLogging !== false) {
    app.addHook("onRequest", ({ state }) => {
      state.set("startedAt", performance.now());
    });
    app.addHook("onResponse", ({ request, requestId, response, state }) => {
      const startedAt = (state.get("startedAt") as number | undefined) ?? performance.now();
      const elapsed = performance.now() - startedAt;
      console.log(JSON.stringify({
        level: "info",
        event: "request.complete",
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: response?.status ?? 500,
        durationMs: Math.round(elapsed * 100) / 100,
      }));
    });
  }

  const repository = new InMemoryUserRepository();
  const service = new UserService(repository);
  for (const route of healthRoutes(config.name)) app.route(route);
  for (const route of userRoutes(service)) app.route(route);
  await app.ready();
  return app;
}
