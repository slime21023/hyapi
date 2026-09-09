import {
  type AppConfig,
  createApplication,
  defineModule,
  definePlugin,
  type HyApplication,
  jwtPlugin,
  providePort,
} from "@hyapi/core";
import { userDirectoryPort } from "./contracts/user-directory.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerOrderRoutes } from "./routes/orders.ts";
import { registerUserRoutes } from "./routes/users.ts";
import { InMemoryUserRepository } from "./repositories/user-repository.ts";
import { UserService } from "./services/user-service.ts";

export interface ExampleAppOptions {
  readonly enableRequestLogging?: boolean;
}

export async function buildExampleApp(
  config: AppConfig,
  jwtSecret: string,
  options: ExampleAppOptions = {},
): Promise<HyApplication> {
  const repository = new InMemoryUserRepository();
  const service = new UserService(repository);
  const healthModule = defineModule({
    name: "health",
    setup(module) {
      registerHealthRoutes(module, config.name);
    },
  });
  const usersModule = defineModule({
    name: "users",
    provides: [providePort(userDirectoryPort, {
      find: async (id) => repository.findById(id),
    })],
    setup(module) {
      registerUserRoutes(module, service);
    },
  });
  const ordersModule = defineModule({
    name: "orders",
    requires: [userDirectoryPort],
    setup(module) {
      registerOrderRoutes(module, module.use(userDirectoryPort));
    },
  });
  const plugins = [
    jwtPlugin({
      secret: jwtSecret,
      ...(Deno.env.get("JWT_ISSUER") ? { issuer: Deno.env.get("JWT_ISSUER")! } : {}),
      ...(Deno.env.get("JWT_AUDIENCE") ? { audience: Deno.env.get("JWT_AUDIENCE")! } : {}),
    }),
  ];

  if (options.enableRequestLogging !== false) {
    plugins.push(definePlugin({
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
    }));
  }

  return await createApplication({
    config,
    modules: [healthModule, usersModule, ordersModule],
    plugins,
  });
}
