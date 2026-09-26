import { defineModule } from "@hyapi/core";
import { userDirectoryPort } from "../../contracts/user-directory.ts";
import { registerOrderRoutes } from "./routes.ts";

export const ordersModule = defineModule({
  name: "orders",
  requires: [userDirectoryPort],
  setup(module) {
    registerOrderRoutes(module, module.use(userDirectoryPort));
  },
});
