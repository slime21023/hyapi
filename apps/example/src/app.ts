import { type AppConfig, createApplication, type HyApplication, jwtPlugin } from "@hyapi/core";
import { createHealthModule } from "./modules/health/module.ts";
import { ordersModule } from "./modules/orders/module.ts";
import { createUsersModule } from "./modules/users/module.ts";

export interface ExampleAppOptions {
  readonly enableRequestLogging?: boolean;
}

export async function buildExampleApp(
  config: AppConfig,
  jwtSecret: string,
  options: ExampleAppOptions = {},
): Promise<HyApplication> {
  let application: HyApplication | undefined;
  const healthModule = createHealthModule(
    config.name,
    async () => application ? await application.health() : { status: "unhealthy", providers: [] },
  );
  const usersModule = createUsersModule();
  const plugins = [
    jwtPlugin({
      secret: jwtSecret,
      ...(Deno.env.get("JWT_ISSUER") ? { issuer: Deno.env.get("JWT_ISSUER")! } : {}),
      ...(Deno.env.get("JWT_AUDIENCE") ? { audience: Deno.env.get("JWT_AUDIENCE")! } : {}),
    }),
  ];

  if (options.enableRequestLogging !== false) {
    plugins.push({
      name: "request-logging",
      setup(platform) {
        platform.addHook("onRequest", ({ state }) => {
          state.set("startedAt", performance.now());
        });
        platform.addHook("onResponse", ({ request, requestId, response, state }) => {
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
      },
    });
  }

  application = await createApplication({
    config,
    modules: [healthModule, usersModule, ordersModule],
    plugins,
  });
  return application;
}
