import { Container } from "@inferdi/inferdi";
import { jwtVerify, type JWTPayload } from "jose";
import * as v from "valibot";
import { createApp, ForbiddenError, HttpError, UnauthorizedError, type Application } from "hyapi";
import { createExampleDatabase, type ExampleDatabase } from "./db.ts";
import { streamResponse } from "./stream.ts";

interface Identity {
  readonly subject: string;
  readonly claims: JWTPayload;
}

/** Business logic has plain arguments; only the composition root knows InferDI. */
class OrderActions {
  private readonly database: ExampleDatabase;
  private readonly owner: string;
  constructor(database: ExampleDatabase, owner: string) {
    this.database = database;
    this.owner = owner;
  }
  purchase(userId: string, sku: string, quantity: number) {
    return this.database.createOrder(userId, sku, quantity, this.owner);
  }
}

const id = v.pipe(v.string(), v.uuid());
const userSchema = v.object({ id, name: v.string(), owner: v.string() });
const inventorySchema = v.object({ sku: v.string(), quantity: v.number() });
const orderSchema = v.object({
  id,
  userId: id,
  sku: v.string(),
  quantity: v.number(),
  owner: v.string(),
});
const quantity = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2147483647));
const stock = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2147483647));

export type ExampleApp = Application;

/** Creates the private PostgreSQL-backed, single-tenant ERP reference application. */
export async function buildExampleApp(options: {
  jwtSecret: string;
  databaseUrl: string;
}): Promise<ExampleApp> {
  const bytes = new TextEncoder().encode(options.jwtSecret);
  if (bytes.byteLength < 32) throw new Error("JWT_SECRET requires at least 32 bytes.");
  if (!options.databaseUrl) throw new Error("DATABASE_URL must be set.");

  const database = await createExampleDatabase(options.databaseUrl);
  const containerRoot = new Container()
    .declareScopeInputs<{ identity: Identity }>()
    .registerValue("database", database)
    .registerValue("jwtKey", bytes)
    .registerFactory(
      "orders",
      (scope) => new OrderActions(scope.get("database"), scope.get("identity").subject),
      ["database", "identity"],
      "scoped",
    );

  async function authenticate(
    request: Request,
    container: typeof containerRoot,
  ): Promise<Identity> {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
    try {
      const { payload } = await jwtVerify(authorization.slice(7), container.get("jwtKey"), {
        algorithms: ["HS256"],
      });
      if (!payload.sub) throw new UnauthorizedError();
      return { subject: payload.sub, claims: payload };
    } catch {
      throw new UnauthorizedError("Invalid bearer token.");
    }
  }

  let app: Application;
  try {
    app = createApp({
      container: containerRoot,
      modules: ({ module }) => [
        module({
          name: "health",
          prefix: "/health",
          routes: (route) => [
            route.get("/live", {
              response: v.object({ status: v.literal("ok") }),
              summary: "Liveness",
              tags: ["Health"],
              handler: () => ({ status: "ok" as const }),
            }),
            route.get("/ready", {
              response: v.object({ status: v.literal("ok") }),
              summary: "PostgreSQL readiness",
              tags: ["Health"],
              async handler({ root }) {
                if (!(await root.get("database").ready()))
                  throw new HttpError(503, "PostgreSQL is unavailable.", "DATABASE_UNAVAILABLE");
                return { status: "ok" as const };
              },
            }),
            route.get("/stream", {
              summary: "Finite heartbeat stream",
              tags: ["Health"],
              handler: streamResponse,
            }),
          ],
        }),
        module({
          name: "users",
          prefix: "/v1/users",
          security: "BearerAuth",
          authenticate,
          routes: (route) => [
            route.post("/", {
              body: v.object({ name: v.pipe(v.string(), v.minLength(1)) }),
              response: userSchema,
              summary: "Create a user owned by the authenticated subject",
              tags: ["Users"],
              handler: ({ body, identity, root }) =>
                root.get("database").createUser(body.name, identity.subject),
            }),
            route.get("/:id", {
              params: v.object({ id }),
              response: userSchema,
              summary: "Read an owned user",
              tags: ["Users"],
              async authorize({ params, identity, root }) {
                const user = await root.get("database").findUser(params.id);
                if (!user) throw new HttpError(404, "User not found.", "USER_NOT_FOUND");
                if (user.owner !== identity.subject) throw new ForbiddenError();
              },
              async handler({ params, root }) {
                const user = await root.get("database").findUser(params.id);
                if (!user) throw new HttpError(404, "User not found.", "USER_NOT_FOUND");
                return user;
              },
            }),
          ],
        }),
        module({
          name: "inventory",
          prefix: "/v1/inventory",
          security: "BearerAuth",
          authenticate,
          routes: (route) => [
            route.post("/", {
              body: v.object({ sku: v.pipe(v.string(), v.minLength(1)), quantity: stock }),
              response: inventorySchema,
              summary: "Set stock (admin only)",
              tags: ["Inventory"],
              authorize({ identity }) {
                if (identity.claims.role !== "admin") throw new ForbiddenError();
              },
              handler: ({ body, root }) =>
                root.get("database").putInventory(body.sku, body.quantity),
            }),
            route.get("/:sku", {
              params: v.object({ sku: v.pipe(v.string(), v.minLength(1)) }),
              response: inventorySchema,
              summary: "Read current stock",
              tags: ["Inventory"],
              async handler({ params, root }) {
                const item = await root.get("database").findInventory(params.sku);
                if (!item)
                  throw new HttpError(404, "Inventory item not found.", "INVENTORY_NOT_FOUND");
                return item;
              },
            }),
          ],
        }),
        module({
          name: "orders",
          prefix: "/v1/orders",
          security: "BearerAuth",
          authenticate,
          routes: (route) => [
            route.post("/", {
              body: v.object({ userId: id, sku: v.pipe(v.string(), v.minLength(1)), quantity }),
              response: orderSchema,
              scoped: true,
              summary: "Purchase stock for an owned user",
              description:
                "Atomically deducts stock and creates the order; rejects insufficient stock.",
              tags: ["Orders"],
              async authorize({ body, identity, root }) {
                const user = await root.get("database").findUser(body.userId);
                if (!user) throw new HttpError(404, "User not found.", "USER_NOT_FOUND");
                if (user.owner !== identity.subject) throw new ForbiddenError();
              },
              handler: ({ body, scope }) =>
                scope.get("orders").purchase(body.userId, body.sku, body.quantity),
            }),
            route.get("/:id", {
              params: v.object({ id }),
              response: orderSchema,
              summary: "Read an owned order",
              tags: ["Orders"],
              async authorize({ params, identity, root }) {
                const order = await root.get("database").findOrder(params.id);
                if (!order) throw new HttpError(404, "Order not found.", "ORDER_NOT_FOUND");
                if (order.owner !== identity.subject) throw new ForbiddenError();
              },
              async handler({ params, root }) {
                const order = await root.get("database").findOrder(params.id);
                if (!order) throw new HttpError(404, "Order not found.", "ORDER_NOT_FOUND");
                return order;
              },
            }),
          ],
        }),
      ],
      openapi: {
        path: "/openapi",
        info: { title: "HyAPI ERP example", version: "0.5.0" },
        securitySchemes: { BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
    });
  } catch (error) {
    await containerRoot.dispose();
    await database.close();
    throw error;
  }
  let shutdown: Promise<void> | undefined;
  return {
    fetch: app.fetch,
    listen: app.listen,
    close() {
      shutdown ??= (async () => {
        await app.close();
        try {
          await containerRoot.dispose();
        } finally {
          await database.close();
        }
      })();
      return shutdown;
    },
  };
}
