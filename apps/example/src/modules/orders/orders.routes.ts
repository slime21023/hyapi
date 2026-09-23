import { defineRoute, NotFoundError, type RouteGroupApi } from "@hyapi/core";
import { CreateOrderSchema, OrderSchema } from "./orders.schemas.ts";
import type { UserDirectory } from "../../contracts/user-directory.ts";

export function registerOrderRoutes(api: RouteGroupApi, users: UserDirectory): void {
  api.group("/v1/orders", { tags: ["orders"], auth: { scopes: ["orders:write"] } }, (orders) => {
    orders.route(
      defineRoute({
        method: "post",
        path: "",
        request: { body: CreateOrderSchema },
        responses: { 201: OrderSchema },
        metadata: { operationId: "createOrder", summary: "Create an order" },
        handler: async ({ body, created }) => {
          const user = await users.find(body.userId);
          if (!user) throw new NotFoundError("Order owner was not found.");
          return created({
            id: crypto.randomUUID(),
            userId: user.id,
            sku: body.sku,
            createdAt: new Date().toISOString(),
          });
        },
      }),
    );
  });
}
