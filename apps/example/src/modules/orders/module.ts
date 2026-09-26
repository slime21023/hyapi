import type { Module } from "@hyapi/core";
import { userDirectoryPort } from "../../contracts/user-directory.ts";
import { registerOrderRoutes } from "./routes.ts";

export const ordersModule: Module = {
  name: "orders",
  requires: [userDirectoryPort],
  setup(module) {
    registerOrderRoutes(module, module.use(userDirectoryPort));
  },
};
