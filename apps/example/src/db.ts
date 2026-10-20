import postgres from "postgres";
import { HttpError } from "hyapi";

export interface User {
  id: string;
  name: string;
  owner: string;
}

export interface InventoryItem {
  sku: string;
  quantity: number;
}

export interface Order {
  id: string;
  userId: string;
  sku: string;
  quantity: number;
  owner: string;
}

export interface ExampleDatabase {
  createUser(name: string, owner: string): Promise<User>;
  findUser(id: string): Promise<User | null>;
  putInventory(sku: string, quantity: number): Promise<InventoryItem>;
  findInventory(sku: string): Promise<InventoryItem | null>;
  createOrder(userId: string, sku: string, quantity: number, owner: string): Promise<Order>;
  findOrder(id: string): Promise<Order | null>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

/** Tables belong to this example, not to Core. Initialize before accepting requests. */
export async function createExampleDatabase(databaseUrl: string): Promise<ExampleDatabase> {
  const sql = postgres(databaseUrl);
  try {
    await sql.begin(async (tx) => {
      // Serialize concurrent app startup migrations against the same database.
      await tx`SELECT pg_advisory_xact_lock(512982541)`;
      await tx`
        CREATE TABLE IF NOT EXISTS hyapi_example_users (
          id uuid PRIMARY KEY,
          name text NOT NULL,
          owner text NOT NULL
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS hyapi_example_inventory (
          sku text PRIMARY KEY,
          quantity integer NOT NULL CHECK (quantity >= 0)
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS hyapi_example_orders (
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES hyapi_example_users(id),
          sku text NOT NULL REFERENCES hyapi_example_inventory(sku),
          quantity integer NOT NULL CHECK (quantity > 0),
          owner text NOT NULL
        )
      `;
    });
  } catch (error) {
    await sql.end();
    throw error;
  }

  return {
    async createUser(name: string, owner: string): Promise<User> {
      const [user] = await sql<User[]>`
        INSERT INTO hyapi_example_users (id, name, owner)
        VALUES (${crypto.randomUUID()}, ${name}, ${owner})
        RETURNING id, name, owner
      `;
      return user!;
    },
    async findUser(id: string): Promise<User | null> {
      const [user] = await sql<User[]>`
        SELECT id, name, owner FROM hyapi_example_users WHERE id = ${id}
      `;
      return user ?? null;
    },
    async putInventory(sku: string, quantity: number): Promise<InventoryItem> {
      const [item] = await sql<InventoryItem[]>`
        INSERT INTO hyapi_example_inventory (sku, quantity)
        VALUES (${sku}, ${quantity})
        ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity
        RETURNING sku, quantity
      `;
      return item!;
    },
    async findInventory(sku: string): Promise<InventoryItem | null> {
      const [item] = await sql<InventoryItem[]>`
        SELECT sku, quantity FROM hyapi_example_inventory WHERE sku = ${sku}
      `;
      return item ?? null;
    },
    async createOrder(
      userId: string,
      sku: string,
      quantity: number,
      owner: string,
    ): Promise<Order> {
      return sql.begin(async (tx) => {
        const [stock] = await tx`
          UPDATE hyapi_example_inventory
          SET quantity = quantity - ${quantity}
          WHERE sku = ${sku} AND quantity >= ${quantity}
          RETURNING sku
        `;
        if (!stock) {
          const [item] = await tx`SELECT sku FROM hyapi_example_inventory WHERE sku = ${sku}`;
          if (!item) throw new HttpError(404, "Inventory item not found.", "INVENTORY_NOT_FOUND");
          throw new HttpError(409, "Insufficient stock.", "INSUFFICIENT_STOCK");
        }
        const [order] = await tx<Order[]>`
          INSERT INTO hyapi_example_orders (id, user_id, sku, quantity, owner)
          VALUES (${crypto.randomUUID()}, ${userId}, ${sku}, ${quantity}, ${owner})
          RETURNING id, user_id AS "userId", sku, quantity, owner
        `;
        return order!;
      });
    },
    async findOrder(id: string): Promise<Order | null> {
      const [order] = await sql<Order[]>`
        SELECT id, user_id AS "userId", sku, quantity, owner
        FROM hyapi_example_orders WHERE id = ${id}
      `;
      return order ?? null;
    },
    async ready(): Promise<boolean> {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    close: () => sql.end(),
  };
}
