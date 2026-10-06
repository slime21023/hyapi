import {
  type AppConfig,
  createApplication,
  defineStateKey,
  type HyApplication,
  type Plugin,
  providePort,
} from "@hyapi/core";
import { jwtBearer } from "@hyapi/plugin-jwt";
import { authPort } from "./contracts/auth.ts";
import { createHealthModule } from "./modules/health/module.ts";
import { ordersModule } from "./modules/orders/module.ts";
import { usersModule } from "./modules/users/module.ts";

const requestStartedAt = defineStateKey<number>("request-logging.startedAt");

export interface ExampleAppOptions {
  readonly enableRequestLogging?: boolean;
}

export async function buildExampleApp(
  config: AppConfig,
  jwtSecret: string,
  options: ExampleAppOptions = {},
): Promise<HyApplication> {
  const authenticate = jwtBearer({
    secret: jwtSecret,
    ...(Deno.env.get("JWT_ISSUER") ? { issuer: Deno.env.get("JWT_ISSUER")! } : {}),
    ...(Deno.env.get("JWT_AUDIENCE") ? { audience: Deno.env.get("JWT_AUDIENCE")! } : {}),
  });
  const plugins: Plugin[] = [];

  if (options.enableRequestLogging !== false) {
    plugins.push({
      name: "request-logging",
      setup(platform) {
        platform.addHook("onRequest", ({ state }) => {
          state.set(requestStartedAt, performance.now());
        });
        platform.addHook("onResponse", ({ request, requestId, response, state }) => {
          const startedAt = state.get(requestStartedAt) ?? performance.now();
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

  return await createApplication({
    config,
    modules: [createHealthModule(config.name), usersModule, ordersModule],
    providers: [providePort(authPort, authenticate)],
    plugins,
  });
}
