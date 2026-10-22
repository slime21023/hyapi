import {test} from 'node:test';
import {Container} from '@inferdi/inferdi';
import * as v from 'valibot';
import {createApp, reply, type Application} from 'hyapi';

// Compile-time contract checks: `bun run check` fails when an expectation no longer holds.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const expectType = <T extends true>(): T | void => undefined;

function declarations() {
  const root = new Container()
    .declareScopeInputs<{identity: {subject: string}}>()
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- widens "s" so the graph stores string
    .registerValue('secret', 's' as string);
  return createApp({
    container: root,
    modules: ({module}) => [
      module({
        name: 'public',
        prefix: '/public',
        routes: route => [
          route.get('/:id', {
            handler({identity, params, scope}) {
              expectType<Equal<typeof identity, undefined>>();
              expectType<Equal<typeof params, Record<string, string>>>();
              expectType<Equal<typeof scope, never>>();
              return 'ok';
            },
          }),
          route.post('/', {
            body: v.object({count: v.number()}),
            handler({body}) {
              expectType<Equal<typeof body, {count: number}>>();
              return body;
            },
          }),
          route.get('/status', {
            response: {201: v.object({id: v.string()})},
            // @ts-expect-error 202 is not a declared response status.
            handler: () => reply(202, {id: 'a'}),
          }),
          route.get('/plain', {
            response: {201: v.object({id: v.string()})},
            // @ts-expect-error A plain value means 200, which this map does not declare.
            handler: () => ({id: 'a'}),
          }),
        ],
      }),
      module({
        name: 'protected',
        prefix: '/protected',
        authenticate: (_request, container) => ({
          subject: container.get('secret'),
          role: 'admin' as const,
        }),
        routes: route => [
          route.get('/', {
            scoped: true,
            handler({identity, scope}) {
              expectType<
                Equal<typeof identity, {subject: string; role: 'admin'}>
              >();
              const secret = scope.get('secret');
              expectType<Equal<typeof secret, string>>();
              return identity.subject;
            },
          }),
        ],
      }),
      // @ts-expect-error Public modules cannot declare an OpenAPI security scheme.
      module({
        name: 'open',
        prefix: '/open',
        security: 'BearerAuth',
        routes: () => [],
      }),
    ],
  });
}

async function shutdown(app: Application) {
  await app.close();
  await app.close({timeoutMs: 1000});
  // @ts-expect-error The close timeout is a number of milliseconds.
  await app.close({timeoutMs: '1000'});
}

test('public type contracts compile', () => {
  void declarations;
  void shutdown;
});
