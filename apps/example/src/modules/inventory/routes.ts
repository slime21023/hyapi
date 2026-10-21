import * as v from "valibot";
import {
  ForbiddenError,
  HttpError,
  type ModuleBuilder,
  type ModuleDefinition,
  type RouteApi,
} from "hyapi";
import { authenticate, type Identity } from "../../auth.ts";
import type { ExampleContainer } from "../../container.ts";
import { findInventory, putInventory } from "./store.ts";

const inventorySchema = v.object({ sku: v.string(), quantity: v.number() });
const stock = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2147483647));

function setStockRoute(route: RouteApi<ExampleContainer, Identity>) {
  return route.post("/", {
    body: v.object({ sku: v.pipe(v.string(), v.minLength(1)), quantity: stock }),
    response: inventorySchema,
    summary: "Set stock (admin only)",
    tags: ["Inventory"],
    authorize({ identity }) {
      if (identity.claims.role !== "admin") throw new ForbiddenError();
    },
    handler: ({ body, root }) => putInventory(root.get("database"), body.sku, body.quantity),
  });
}

function readStockRoute(route: RouteApi<ExampleContainer, Identity>) {
  return route.get("/:sku", {
    params: v.object({ sku: v.pipe(v.string(), v.minLength(1)) }),
    response: inventorySchema,
    summary: "Read current stock",
    tags: ["Inventory"],
    async handler({ params, root }) {
      const item = await findInventory(root.get("database"), params.sku);
      if (!item) throw new HttpError(404, "Inventory item not found.", "INVENTORY_NOT_FOUND");
      return item;
    },
  });
}

export function inventoryModule(module: ModuleBuilder<ExampleContainer>): ModuleDefinition {
  return module({
    name: "inventory",
    prefix: "/v1/inventory",
    security: "BearerAuth",
    authenticate,
    routes: (route) => [setStockRoute(route), readStockRoute(route)],
  });
}
