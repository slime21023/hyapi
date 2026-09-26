import { defineModule, type Module, providePort } from "@hyapi/core";
import { type UserDirectoryEntry, userDirectoryPort } from "../../contracts/user-directory.ts";
import { InMemoryUserRepository } from "./repository.ts";
import { UserService } from "./service.ts";
import { registerUserRoutes } from "./routes.ts";
import type { User } from "./schema.ts";

export function createUsersModule(): Module {
  const repository = new InMemoryUserRepository();
  return defineModule({
    name: "users",
    provides: [providePort(userDirectoryPort, {
      find: async (id) => toDirectoryEntry(repository.findById(id)),
    })],
    setup(module) {
      const service = module.singleton(() => new UserService(repository));
      registerUserRoutes(module, service);
    },
  });
}

function toDirectoryEntry(user: User | null): UserDirectoryEntry | null {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email };
}
