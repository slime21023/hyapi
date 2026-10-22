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
import {createUser, findUser} from './store.ts';

const id = v.pipe(v.string(), v.uuid());
const userSchema = v.object({id, name: v.string(), owner: v.string()});

function createUserRoute(route: RouteApi<ExampleContainer, Identity>) {
  return route.post('/', {
    body: v.object({name: v.pipe(v.string(), v.minLength(1))}),
    response: userSchema,
    summary: 'Create a user owned by the authenticated subject',
    tags: ['Users'],
    handler: ({body, identity, root}) =>
      createUser(root.get('database'), body.name, identity.subject),
  });
}

function readUserRoute(route: RouteApi<ExampleContainer, Identity>) {
  return route.get('/:id', {
    params: v.object({id}),
    response: userSchema,
    summary: 'Read an owned user',
    tags: ['Users'],
    async authorize({params, identity, root}) {
      const user = await findUser(root.get('database'), params.id);
      if (!user) throw new HttpError(404, 'User not found.', 'USER_NOT_FOUND');
      if (user.owner !== identity.subject) throw new ForbiddenError();
    },
    async handler({params, root}) {
      const user = await findUser(root.get('database'), params.id);
      if (!user) throw new HttpError(404, 'User not found.', 'USER_NOT_FOUND');
      return user;
    },
  });
}

export function usersModule(
  module: ModuleBuilder<ExampleContainer>,
): ModuleDefinition {
  return module({
    name: 'users',
    prefix: '/v1/users',
    security: 'BearerAuth',
    authenticate,
    routes: route => [createUserRoute(route), readUserRoute(route)],
  });
}
