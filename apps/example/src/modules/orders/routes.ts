import * as v from 'valibot';
import {
  ForbiddenError,
  HttpError,
  type ModuleBuilder,
  type ModuleDefinition,
  type RouteApi,
} from 'hyapi';
import {authenticate, type Identity} from '../../auth.ts';
import type {ExampleContainer} from '../../container.ts';
import {findUser} from '../users/store.ts';
import {findOrder} from './store.ts';

const id = v.pipe(v.string(), v.uuid());
const orderSchema = v.object({
  id,
  userId: id,
  sku: v.string(),
  quantity: v.number(),
  owner: v.string(),
});
const quantity = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(2147483647),
);

type OrdersRoute = RouteApi<ExampleContainer, Identity>;

function purchaseRoute(route: OrdersRoute) {
  return route.post('/', {
    body: v.object({
      userId: id,
      sku: v.pipe(v.string(), v.minLength(1)),
      quantity,
    }),
    response: orderSchema,
    scoped: true,
    summary: 'Purchase stock for an owned user',
    description:
      'Atomically deducts stock and creates the order; rejects insufficient stock.',
    tags: ['Orders'],
    async authorize({body, identity, root}) {
      const user = await findUser(root.get('database'), body.userId);
      if (!user) throw new HttpError(404, 'User not found.', 'USER_NOT_FOUND');
      if (user.owner !== identity.subject) throw new ForbiddenError();
    },
    handler: ({body, scope}) =>
      scope.get('orders').purchase(body.userId, body.sku, body.quantity),
  });
}

function readOrderRoute(route: OrdersRoute) {
  return route.get('/:id', {
    params: v.object({id}),
    response: orderSchema,
    summary: 'Read an owned order',
    tags: ['Orders'],
    async authorize({params, identity, root}) {
      const order = await findOrder(root.get('database'), params.id);
      if (!order) {
        throw new HttpError(404, 'Order not found.', 'ORDER_NOT_FOUND');
      }
      if (order.owner !== identity.subject) throw new ForbiddenError();
    },
    async handler({params, root}) {
      const order = await findOrder(root.get('database'), params.id);
      if (!order) {
        throw new HttpError(404, 'Order not found.', 'ORDER_NOT_FOUND');
      }
      return order;
    },
  });
}

export function ordersModule(
  module: ModuleBuilder<ExampleContainer>,
): ModuleDefinition {
  return module({
    name: 'orders',
    prefix: '/v1/orders',
    security: 'BearerAuth',
    authenticate,
    routes: route => [purchaseRoute(route), readOrderRoute(route)],
  });
}
