import type postgres from 'postgres';
import {reserveStock} from '../inventory/store.ts';
import {insertOrder, type Order} from './store.ts';

export class OrderActions {
  private readonly database: postgres.Sql;
  private readonly owner: string;
  constructor(database: postgres.Sql, owner: string) {
    this.database = database;
    this.owner = owner;
  }
  purchase(userId: string, sku: string, quantity: number): Promise<Order> {
    return this.database.begin(async tx => {
      await reserveStock(tx, sku, quantity);
      return insertOrder(tx, userId, sku, quantity, this.owner);
    });
  }
}
