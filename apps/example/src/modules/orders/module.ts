import type { Guard, Module } from "@hyapi/core";
import { userDirectoryPort } from "../../contracts/user-directory.ts";
import { registerOrderRoutes } from "./routes.ts";

export function createOrdersModule(authenticate: Guard): Module {
  return {
    name: "orders",
    requires: [userDirectoryPort],
    setup(module) {
      registerOrderRoutes(module, module.use(userDirectoryPort), authenticate);
    },
  };
}
