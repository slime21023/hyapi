import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Container} from '@inferdi/inferdi';
import * as v from 'valibot';
import {createApp} from 'hyapi';

const origin = 'http://localhost';

function fixture(options: {disposeFails?: boolean} = {}) {
  const events: string[] = [];
  const root = new Container().registerFactory(
    'resource',
    () => {
      events.push('open');
      return {
        dispose() {
          events.push('close');
          if (options.disposeFails) {
            throw new Error('resource cleanup internals');
          }
        },
      };
    },
    'scoped',
  );
  const app = createApp({
    container: root,
    modules: ({module}) => [
      module({
        name: 'scopes',
        prefix: '/scopes',
        routes: route => [
          route.get('/lazy', {scoped: true, handler: () => 'unused'}),
          route.get('/used', {
            scoped: true,
            handler: ({scope}) => (scope.get('resource'), 'used'),
          }),
          route.get('/undeclared', {
            handler: ({scope}) => (
              (scope as unknown as {get(key: string): unknown}).get('resource'),
              'no'
            ),
          }),
          route.get('/throws', {
            scoped: true,
            handler({scope}) {
              scope.get('resource');
              throw new Error('handler internals');
            },
          }),
          route.get('/invalid', {
            scoped: true,
            response: v.object({count: v.number()}),
            handler: ({scope}) => (
              scope.get('resource'),
              {count: 'many'} as never
            ),
          }),
          route.get('/stream', {
            scoped: true,
            handler({scope}) {
              scope.get('resource');
              const encoder = new TextEncoder();
              let sent = 0;
              return new Response(
                new ReadableStream({
                  async pull(controller) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                    if (sent === 3) return controller.close();
                    controller.enqueue(encoder.encode(String(++sent)));
                  },
                }),
              );
            },
          }),
        ],
      }),
    ],
  });
  const send = (path: string) => app.fetch(new Request(`${origin}${path}`));
  const close = async () => {
    await app.close();
    await root.dispose();
  };
  return {events, send, close};
}

test('a scoped route opens its scope only when the scope is read', async () => {
  const {events, send, close} = fixture();
  try {
    assert.equal(await (await send('/scopes/lazy')).text(), 'unused');
    assert.deepEqual(events, []);
    assert.equal(await (await send('/scopes/used')).text(), 'used');
    assert.deepEqual(events, ['open', 'close']);
  } finally {
    await close();
  }
});

test('reading a scope without declaring it fails privately', async () => {
  const {events, send, close} = fixture();
  try {
    const response = await send('/scopes/undeclared');
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, 'INTERNAL_SERVER_ERROR');
    assert.deepEqual(events, []);
  } finally {
    await close();
  }
});

test('handler and response-validation failures still dispose the scope', async () => {
  const {events, send, close} = fixture();
  try {
    for (const path of ['/scopes/throws', '/scopes/invalid']) {
      events.length = 0;
      const response = await send(path);
      assert.equal(response.status, 500, path);
      assert.equal((await response.text()).includes('internals'), false, path);
      assert.deepEqual(events, ['open', 'close'], path);
    }
  } finally {
    await close();
  }
});

test('a streamed body outlives the handler scope that produced it', async () => {
  const {events, send, close} = fixture();
  try {
    const response = await send('/scopes/stream');
    assert.equal(response.status, 200);
    assert.deepEqual(events, ['open', 'close']);
    assert.equal(await response.text(), '123');
  } finally {
    await close();
  }
});

// A failed cleanup replaces an otherwise successful response. Handlers with committed side
// effects therefore risk a client retry; see docs/guide/di-lifecycle.md.
test('a scope cleanup failure turns the response into a private 500', async () => {
  const {events, send, close} = fixture({disposeFails: true});
  try {
    const response = await send('/scopes/used');
    assert.equal(response.status, 500);
    assert.equal(
      (await response.text()).includes('resource cleanup internals'),
      false,
    );
    assert.deepEqual(events, ['open', 'close']);
  } finally {
    await close();
  }
});
