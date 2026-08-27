import { ConflictError, NotFoundError } from "@hyapi/core";
import type { CreateUserInput, UpdateUserInput } from "../schemas.ts";
import type { UserRepository } from "../repositories/user-repository.ts";

export class UserService {
  constructor(private readonly repository: UserRepository) {}

  list(offset: number, limit: number) {
    return { data: this.repository.list(offset, limit), total: this.repository.count() };
  }

  get(id: string) {
    const user = this.repository.findById(id);
    if (!user) throw new NotFoundError("User was not found.");
    return user;
  }

  create(input: CreateUserInput) {
    if (this.repository.findByEmail(input.email)) {
      throw new ConflictError("A user with this email already exists.");
    }
    return this.repository.create(input);
  }

  update(id: string, input: UpdateUserInput) {
    if (input.email) {
      const existing = this.repository.findByEmail(input.email);
      if (existing && existing.id !== id) {
        throw new ConflictError("A user with this email already exists.");
      }
    }
    const user = this.repository.update(id, input);
    if (!user) throw new NotFoundError("User was not found.");
    return user;
  }

  delete(id: string): void {
    if (!this.repository.delete(id)) throw new NotFoundError("User was not found.");
  }
}
