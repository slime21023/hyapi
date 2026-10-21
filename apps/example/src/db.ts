import postgres from "postgres";
import { initUsers } from "./modules/users/store.ts";
import { initInventory } from "./modules/inventory/store.ts";
import { initOrders } from "./modules/orders/store.ts";

/** Tables belong to this example, not to Core. Initialize before accepting requests. */
export async function openExampleDatabase(databaseUrl: string): Promise<postgres.Sql> {
  const sql = postgres(databaseUrl);
  try {
    await sql.begin(async (tx) => {
      // Serialize concurrent app startup migrations against the same database.
      await tx`SELECT pg_advisory_xact_lock(512982541)`;
      await initUsers(tx);
      await initInventory(tx);
      await initOrders(tx);
    });
  } catch (error) {
    await sql.end();
    throw error;
  }

  return sql;
}
