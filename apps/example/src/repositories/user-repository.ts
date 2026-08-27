import type { CreateUserInput, UpdateUserInput, User } from "../schemas.ts";

export interface UserRepository {
  list(offset: number, limit: number): User[];
  count(): number;
  findById(id: string): User | null;
  findByEmail(email: string): User | null;
  create(input: CreateUserInput): User;
  update(id: string, input: UpdateUserInput): User | null;
  delete(id: string): boolean;
}

export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();

  list(offset: number, limit: number): User[] {
    return [...this.users.values()].slice(offset, offset + limit);
  }

  count(): number {
    return this.users.size;
  }

  findById(id: string): User | null {
    return this.users.get(id) ?? null;
  }

  findByEmail(email: string): User | null {
    const normalized = email.toLowerCase();
    return [...this.users.values()].find((user) => user.email === normalized) ?? null;
  }

  create(input: CreateUserInput): User {
    const now = new Date().toISOString();
    const user: User = {
      id: crypto.randomUUID(),
      name: input.name,
      email: input.email.toLowerCase(),
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  update(id: string, input: UpdateUserInput): User | null {
    const current = this.users.get(id);
    if (!current) return null;
    const user: User = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email.toLowerCase() } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, user);
    return user;
  }

  delete(id: string): boolean {
    return this.users.delete(id);
  }
}
