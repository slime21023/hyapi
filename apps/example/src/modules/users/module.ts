import type { Guard, Module } from "@hyapi/core";
import { type UserDirectoryEntry, userDirectoryPort } from "../../contracts/user-directory.ts";
import { InMemoryUserRepository } from "./repository.ts";
import { UserService } from "./service.ts";
import { registerUserRoutes } from "./routes.ts";
import type { User } from "./schema.ts";

export function createUsersModule(authenticate: Guard): Module {
  return {
    name: "users",
    provides: [userDirectoryPort],
    setup(module) {
      const repository = module.singleton(() => new InMemoryUserRepository());
      const service = module.singleton(async (services) =>
        new UserService(await services.get(repository))
      );
      module.provide(userDirectoryPort, async (services) => {
        const users = await services.get(repository);
        return { find: async (id) => toDirectoryEntry(users.findById(id)) };
      });
      registerUserRoutes(module, service, authenticate);
    },
  };
}

function toDirectoryEntry(user: User | null): UserDirectoryEntry | null {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email };
}
