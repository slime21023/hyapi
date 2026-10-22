import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {test} from 'node:test';
import {Container} from '@inferdi/inferdi';
import * as v from 'valibot';
import {createApp, UnauthorizedError} from 'hyapi';

const origin = 'http://localhost';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

/** Fails the test instead of hanging it when a promise never settles. */
function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`still pending after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function settledWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise(resolve => setTimeout(resolve, ms));
  return settled;
}

function fixture() {
  const events: string[] = [];
  const entered = deferred();
  const release = deferred();
  const root = new Container().registerFactory(
    'resource',
    () => ({dispose: () => void events.push('disposed')}),
    'scoped',
  );
  const app = createApp({
    container: root,
    modules: ({module}) => [
      module({
        name: 'work',
        prefix: '/work',
        routes: route => [
          route.get('/ok', {handler: () => 'ok'}),
          route.post('/strict', {
            body: v.object({n: v.number()}),
            handler: () => 'ok',
          }),
          route.get('/fail', {
            handler() {
              throw new Error('boom');
            },
          }),
          route.get('/hold', {
            scoped: true,
            async handler({scope}) {
              scope.get('resource');
              entered.resolve();
              await release.promise;
              return 'released';
            },
          }),
          route.get('/stream', {
            handler: () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('partial'));
                  },
                }),
              ),
          }),
        ],
      }),
      module({
        name: 'private',
        prefix: '/private',
        authenticate() {
          throw new UnauthorizedError();
        },
        routes: route => [route.get('/', {handler: () => 'never'})],
      }),
    ],
  });
  const send = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${origin}${path}`, init));
  return {app, root, events, entered, release, send};
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.ok(address && typeof address === 'object');
  return address.port;
}

test('closing completes after requests that ended in errors', async () => {
  const {app, root, send} = fixture();
  try {
    assert.equal((await send('/private/')).status, 401);
    const invalid = {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    };
    assert.equal((await send('/work/strict', invalid)).status, 400);
    assert.equal((await send('/missing')).status, 404);
    assert.equal((await send('/work/fail')).status, 500);
    await within(app.close());
  } finally {
    await root.dispose();
  }
});

test('closing is shared, final, and does not wait for a returned stream to be read', async () => {
  const {app, root, send} = fixture();
  try {
    const stream = await send('/work/stream');
    assert.equal(stream.status, 200);
    const first = app.close();
    assert.equal(app.close(), first);
    await within(first);
    await assert.rejects(app.listen({port: 0}), /Cannot listen after closing/);
    assert.equal((await send('/work/ok')).status, 503);
    await stream.body?.cancel();
  } finally {
    await root.dispose();
  }
});

test('closing while a listener is binding releases its port', async () => {
  const {app, root} = fixture();
  const port = await freePort();
  try {
    const binding = app.listen({hostname: '127.0.0.1', port});
    const closing = app.close();
    await assert.rejects(binding, /closed during listen/);
    await within(closing);
  } finally {
    await root.dispose();
  }
  const other = fixture();
  try {
    const listener = await other.app.listen({hostname: '127.0.0.1', port});
    assert.equal(listener.url.port, String(port));
  } finally {
    await other.app.close();
    await other.root.dispose();
  }
});

test('closing without a timeout waits for an accepted handler', async () => {
  const {app, root, events, entered, release, send} = fixture();
  try {
    const held = send('/work/hold');
    await entered.promise;
    const closing = app.close();
    assert.equal(await settledWithin(closing, 50), false);
    assert.equal((await send('/work/ok')).status, 503);
    release.resolve();
    assert.equal(await (await held).text(), 'released');
    await within(closing);
    assert.deepEqual(events, ['disposed']);
  } finally {
    release.resolve();
    await root.dispose();
  }
});

test('a close timeout rejects that call while the accepted handler keeps running', async () => {
  const {app, root, events, entered, release, send} = fixture();
  try {
    const held = send('/work/hold');
    await entered.promise;
    await assert.rejects(
      within(app.close({timeoutMs: 20})),
      /Application close timed out/,
    );
    assert.equal((await send('/work/ok')).status, 503);
    assert.deepEqual(events, []);
    release.resolve();
    assert.equal(await (await held).text(), 'released');
    await within(app.close());
    assert.deepEqual(events, ['disposed']);
  } finally {
    release.resolve();
    await root.dispose();
  }
});

test('a close timeout that is not met is cleared once draining finishes', async () => {
  const {app, root} = fixture();
  try {
    await within(app.close({timeoutMs: 60_000}), 1000);
  } finally {
    await root.dispose();
  }
});

test('an invalid close timeout is rejected without starting shutdown', async () => {
  const {app, root, send} = fixture();
  try {
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        within(app.close({timeoutMs})),
        RangeError,
        String(timeoutMs),
      );
    }
    assert.equal((await send('/work/ok')).status, 200);
  } finally {
    await app.close();
    await root.dispose();
  }
});
