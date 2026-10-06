import type { Module } from "@hyapi/core";
import { authPort } from "../../contracts/auth.ts";
import { userDirectoryPort } from "../../contracts/user-directory.ts";
import { registerOrderRoutes } from "./routes.ts";

export const ordersModule: Module = {
  name: "orders",
  requires: [authPort, userDirectoryPort],
  setup(module) {
    registerOrderRoutes(module, module.use(userDirectoryPort), module.use(authPort));
  },
};
