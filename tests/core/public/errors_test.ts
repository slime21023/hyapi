import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Container} from '@inferdi/inferdi';
import * as v from 'valibot';
import {
  createApp,
  ForbiddenError,
  reply,
  UnauthorizedError,
  type ApplicationOptions,
} from 'hyapi';

const origin = 'http://localhost';

function fixture(
  onError: NonNullable<ApplicationOptions<Container>['onError']>,
) {
  const root = new Container().registerFactory(
    'fragile',
    () => ({
      dispose() {
        throw new Error('cleanup failed');
      },
    }),
    'scoped',
  );
  const app = createApp({
    container: root,
    onError,
    modules: ({module}) => [
      module({
        name: 'failures',
        prefix: '/f',
        routes: route => [
          route.get('/ok', {handler: () => 'ok'}),
          route.get('/handler', {
            handler() {
              throw new Error('handler failed');
            },
          }),
          route.get('/response', {
            response: v.object({n: v.number()}),
            handler: () => ({n: 'x'}) as never,
          }),
          route.get('/reply', {
            response: {201: v.object({n: v.number()})},
            handler: () => reply(202, {n: 1}) as never,
          }),
          route.get('/dispose', {
            scoped: true,
            handler: ({scope}) => (scope.get('fragile'), 'done'),
          }),
          route.get('/forbidden', {
            handler() {
              throw new ForbiddenError();
            },
          }),
          route.post('/strict', {
            body: v.object({n: v.number()}),
            handler: () => 'ok',
          }),
        ],
      }),
      module({
        name: 'private',
        prefix: '/p',
        authenticate(request) {
          if (request.headers.get('authorization') === 'boom') {
            throw new Error('authenticate failed');
          }
          throw new UnauthorizedError();
        },
        routes: route => [route.get('/', {handler: () => 'never'})],
      }),
    ],
  });
  const send = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${origin}${path}`, init));
  const close = async () => {
    await app.close();
    await root.dispose();
  };
  return {app, send, close};
}

test('every private 500 is reported with its original error and request', async () => {
  const reported: Array<{message: string; path: string}> = [];
  const {send, close} = fixture((error, request) => {
    reported.push({
      message: error instanceof Error ? error.message : String(error),
      path: new URL(request.url).pathname,
    });
  });
  try {
    const failures: Array<[path: string, init?: RequestInit]> = [
      ['/f/handler'],
      ['/p/', {headers: {authorization: 'boom'}}],
      ['/f/response'],
      ['/f/reply'],
      ['/f/dispose'],
    ];
    for (const [path, init] of failures) {
      const response = await send(path, init);
      assert.equal(response.status, 500, path);
      assert.equal(
        (await response.json()).detail,
        'Internal server error.',
        path,
      );
    }
    assert.deepEqual(
      reported.map(({path}) => path),
      failures.map(([path]) => path),
    );
    assert.equal(reported[0]!.message, 'handler failed');
    assert.equal(reported[1]!.message, 'authenticate failed');
    assert.match(reported[3]!.message, /undeclared status 202/);
  } finally {
    await close();
  }
});

test('expected failures and successes are not reported', async () => {
  const reported: unknown[] = [];
  const {app, send, close} = fixture(error => void reported.push(error));
  try {
    const json = {'content-type': 'application/json'};
    assert.equal((await send('/f/ok')).status, 200);
    assert.equal(
      (await send('/f/strict', {method: 'POST', headers: json, body: '{'}))
        .status,
      400,
    );
    assert.equal(
      (await send('/f/strict', {method: 'POST', headers: json, body: '{}'}))
        .status,
      400,
    );
    assert.equal((await send('/p/')).status, 401);
    assert.equal((await send('/f/forbidden')).status, 403);
    assert.equal((await send('/missing')).status, 404);
    assert.equal(
      (await app.fetch(new Request('http://l/xx/f/ok'))).status,
      400,
    );
    await app.close();
    assert.equal((await send('/f/ok')).status, 503);
    assert.deepEqual(reported, []);
  } finally {
    await close();
  }
});

test('a failing or pending observer cannot change or delay the response', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const observers: Array<
    NonNullable<ApplicationOptions<Container>['onError']>
  > = [
    () => {
      throw new Error('observer threw');
    },
    () => Promise.reject(new Error('observer rejected')),
    () => new Promise<void>(() => {}),
  ];
  try {
    for (const observer of observers) {
      const {send, close} = fixture(observer);
      try {
        const started = performance.now();
        const response = await send('/f/handler');
        assert.equal(response.status, 500);
        assert.equal((await response.json()).code, 'INTERNAL_SERVER_ERROR');
        assert.ok(performance.now() - started < 1000);
      } finally {
        await close();
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
