import {Container} from '@inferdi/inferdi';
import type postgres from 'postgres';
import type {Identity} from './auth.ts';
import {OrderActions} from './modules/orders/purchase.ts';

export function createExampleContainer(
  database: postgres.Sql,
  jwtKey: Uint8Array,
) {
  return new Container()
    .declareScopeInputs<{identity: Identity}>()
    .registerValue('database', database)
    .registerValue('jwtKey', jwtKey)
    .registerFactory(
      'orders',
      scope =>
        new OrderActions(scope.get('database'), scope.get('identity').subject),
      ['database', 'identity'],
      'scoped',
    );
}

export type ExampleContainer = ReturnType<typeof createExampleContainer>;
