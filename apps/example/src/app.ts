import { createApp, type Application, type CloseOptions } from "hyapi";
import { createExampleContainer } from "./container.ts";
import { openExampleDatabase } from "./db.ts";
import { healthModule } from "./modules/health.ts";
import { inventoryModule } from "./modules/inventory/routes.ts";
import { ordersModule } from "./modules/orders/routes.ts";
import { usersModule } from "./modules/users/routes.ts";

export type ExampleApp = Application;

/** Creates the private PostgreSQL-backed, single-tenant ERP reference application. */
export async function buildExampleApp(options: {
  jwtSecret: string;
  databaseUrl: string;
}): Promise<ExampleApp> {
  const bytes = new TextEncoder().encode(options.jwtSecret);
  if (bytes.byteLength < 32) throw new Error("JWT_SECRET requires at least 32 bytes.");
  if (!options.databaseUrl) throw new Error("DATABASE_URL must be set.");

  const database = await openExampleDatabase(options.databaseUrl);
  const containerRoot = createExampleContainer(database, bytes);
  let app: Application;
  try {
    app = createApp({
      container: containerRoot,
      modules: ({ module }) => [
        healthModule(module),
        usersModule(module),
        inventoryModule(module),
        ordersModule(module),
      ],
      openapi: {
        path: "/openapi",
        info: { title: "HyAPI ERP example", version: "0.5.0" },
        securitySchemes: { BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
    });
  } catch (error) {
    await containerRoot.dispose();
    await database.end();
    throw error;
  }
  let shutdown: Promise<void> | undefined;
  return {
    fetch: app.fetch,
    listen: app.listen,
    close(settings?: CloseOptions) {
      shutdown ??= (async () => {
        // On timeout, keep the root and database open: abandoned handlers may still use them.
        await app.close(settings);
        try {
          await containerRoot.dispose();
        } finally {
          await database.end();
        }
      })();
      return shutdown;
    },
  };
}
