import type postgres from "postgres";

export interface Order {
  id: string;
  userId: string;
  sku: string;
  quantity: number;
  owner: string;
}

export async function initOrders(tx: postgres.TransactionSql): Promise<void> {
  await tx`
    CREATE TABLE IF NOT EXISTS hyapi_example_orders (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES hyapi_example_users(id),
      sku text NOT NULL REFERENCES hyapi_example_inventory(sku),
      quantity integer NOT NULL CHECK (quantity > 0),
      owner text NOT NULL
    )
  `;
}

export async function insertOrder(
  tx: postgres.TransactionSql,
  userId: string,
  sku: string,
  quantity: number,
  owner: string,
): Promise<Order> {
  const [order] = await tx<Order[]>`
    INSERT INTO hyapi_example_orders (id, user_id, sku, quantity, owner)
    VALUES (${crypto.randomUUID()}, ${userId}, ${sku}, ${quantity}, ${owner})
    RETURNING id, user_id AS "userId", sku, quantity, owner
  `;
  return order!;
}

export async function findOrder(sql: postgres.Sql, id: string): Promise<Order | null> {
  const [order] = await sql<Order[]>`
    SELECT id, user_id AS "userId", sku, quantity, owner
    FROM hyapi_example_orders WHERE id = ${id}
  `;
  return order ?? null;
}
