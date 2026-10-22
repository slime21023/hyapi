import type postgres from 'postgres';
import {HttpError} from 'hyapi';

export interface InventoryItem {
  sku: string;
  quantity: number;
}

export async function initInventory(
  tx: postgres.TransactionSql,
): Promise<void> {
  await tx`
    CREATE TABLE IF NOT EXISTS hyapi_example_inventory (
      sku text PRIMARY KEY,
      quantity integer NOT NULL CHECK (quantity >= 0)
    )
  `;
}

export async function putInventory(
  sql: postgres.Sql,
  sku: string,
  quantity: number,
): Promise<InventoryItem> {
  const [item] = await sql<InventoryItem[]>`
    INSERT INTO hyapi_example_inventory (sku, quantity)
    VALUES (${sku}, ${quantity})
    ON CONFLICT (sku) DO UPDATE SET quantity = EXCLUDED.quantity
    RETURNING sku, quantity
  `;
  return item!;
}

export async function findInventory(
  sql: postgres.Sql,
  sku: string,
): Promise<InventoryItem | null> {
  const [item] = await sql<InventoryItem[]>`
    SELECT sku, quantity FROM hyapi_example_inventory WHERE sku = ${sku}
  `;
  return item ?? null;
}

export async function reserveStock(
  tx: postgres.TransactionSql,
  sku: string,
  quantity: number,
): Promise<void> {
  const [stock] = await tx`
    UPDATE hyapi_example_inventory
    SET quantity = quantity - ${quantity}
    WHERE sku = ${sku} AND quantity >= ${quantity}
    RETURNING sku
  `;
  if (!stock) {
    const [item] =
      await tx`SELECT sku FROM hyapi_example_inventory WHERE sku = ${sku}`;
    if (!item) {
      throw new HttpError(
        404,
        'Inventory item not found.',
        'INVENTORY_NOT_FOUND',
      );
    }
    throw new HttpError(409, 'Insufficient stock.', 'INSUFFICIENT_STOCK');
  }
}
