import type postgres from "postgres";

export interface User {
  id: string;
  name: string;
  owner: string;
}

export async function initUsers(tx: postgres.TransactionSql): Promise<void> {
  await tx`
    CREATE TABLE IF NOT EXISTS hyapi_example_users (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      owner text NOT NULL
    )
  `;
}

export async function createUser(sql: postgres.Sql, name: string, owner: string): Promise<User> {
  const [user] = await sql<User[]>`
    INSERT INTO hyapi_example_users (id, name, owner)
    VALUES (${crypto.randomUUID()}, ${name}, ${owner})
    RETURNING id, name, owner
  `;
  return user!;
}

export async function findUser(
  sql: postgres.Sql | postgres.TransactionSql,
  id: string,
): Promise<User | null> {
  const [user] = await sql<User[]>`
    SELECT id, name, owner FROM hyapi_example_users WHERE id = ${id}
  `;
  return user ?? null;
}
