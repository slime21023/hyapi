import { assertEquals, assertThrows } from "@std/assert";
import { ConflictError, NotFoundError } from "@hyapi/core";
import { UserService } from "./user-service.ts";
import { InMemoryUserRepository } from "./user-repository.ts";

Deno.test("UserService - CRUD operations and business rules", () => {
  const repository = new InMemoryUserRepository();
  const service = new UserService(repository);

  // 1. Initial list is empty
  const initial = service.list(0, 10);
  assertEquals(initial.total, 0);
  assertEquals(initial.data.length, 0);

  // 2. Create users
  const user1 = service.create({
    email: "ada@example.com",
    name: "Ada Lovelace",
  });
  assertEquals(user1.email, "ada@example.com");
  assertEquals(user1.name, "Ada Lovelace");

  const user2 = service.create({
    email: "grace@example.com",
    name: "Grace Hopper",
  });

  // 3. Create with duplicate email throws ConflictError
  assertThrows(
    () => service.create({ email: "ada@example.com", name: "Ada Clone" }),
    ConflictError,
    "A user with this email already exists.",
  );

  // 4. List with pagination
  const listed = service.list(0, 1);
  assertEquals(listed.total, 2);
  assertEquals(listed.data.length, 1);
  assertEquals(listed.data[0]?.id, user1.id);

  // 5. Get user
  const found = service.get(user1.id);
  assertEquals(found.id, user1.id);

  assertThrows(
    () => service.get("non-existent-id"),
    NotFoundError,
    "User was not found.",
  );

  // 6. Update user
  const updated = service.update(user1.id, { name: "Ada King, Countess of Lovelace" });
  assertEquals(updated.name, "Ada King, Countess of Lovelace");

  // Updating email to existing other user's email throws ConflictError
  assertThrows(
    () => service.update(user1.id, { email: "grace@example.com" }),
    ConflictError,
  );

  // Updating email to own email succeeds
  const updatedSelf = service.update(user1.id, { email: "ada@example.com" });
  assertEquals(updatedSelf.email, "ada@example.com");

  // Updating non-existent user throws NotFoundError
  assertThrows(
    () => service.update("unknown-id", { name: "Ghost" }),
    NotFoundError,
  );

  // 7. Delete user
  service.delete(user1.id);
  assertThrows(() => service.get(user1.id), NotFoundError);

  // Deleting again throws NotFoundError
  assertThrows(() => service.delete(user1.id), NotFoundError);

  const remaining = service.list(0, 10);
  assertEquals(remaining.total, 1);
  assertEquals(remaining.data[0]?.id, user2.id);
});
