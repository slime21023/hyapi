import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Container} from '@inferdi/inferdi';
import * as v from 'valibot';
import {createApp, reply} from 'hyapi';

const origin = 'http://localhost';
const item = v.object({id: v.string()});

function fixture() {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({module}) => [
      module({
        name: 'responses',
        prefix: '/r',
        routes: route => [
          route.get('/default', {
            response: {200: item},
            handler: () => ({id: 'a'}),
          }),
          route.get('/explicit-200', {
            response: {200: item},
            handler: () => reply(200, {id: 'b'}),
          }),
          route.get('/invalid', {
            response: item,
            handler: () => ({id: 1}) as never,
          }),
          route.get('/undeclared-map', {
            response: {201: item},
            handler: () => reply(202, {id: 'c'}) as never,
          }),
          route.get('/undeclared-single', {
            response: item,
            handler: () => reply(201, {id: 'd'}) as never,
          }),
          route.get('/unconstrained', {
            handler: () => reply(202, {queued: true}),
          }),
          route.get('/native', {
            response: item,
            handler: () => new Response('not json', {status: 207}),
          }),
        ],
      }),
    ],
  });
  const send = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${origin}${path}`, init));
  const close = async () => {
    await app.close();
    await root.dispose();
  };
  return {send, close};
}

test('plain values and explicit 200 replies use the declared 200 schema', async () => {
  const {send, close} = fixture();
  try {
    for (const [path, id] of [
      ['/r/default', 'a'],
      ['/r/explicit-200', 'b'],
    ] as const) {
      const response = await send(path);
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), {id}, path);
    }
  } finally {
    await close();
  }
});

test('a body that violates its response schema fails privately', async () => {
  const {send, close} = fixture();
  try {
    const response = await send('/r/invalid');
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, 'INTERNAL_SERVER_ERROR');
  } finally {
    await close();
  }
});

test('a reply status missing from the declared responses fails privately', async () => {
  const {send, close} = fixture();
  try {
    for (const path of ['/r/undeclared-map', '/r/undeclared-single']) {
      const response = await send(path);
      assert.equal(response.status, 500, path);
      assert.equal((await response.json()).code, 'INTERNAL_SERVER_ERROR', path);
    }
  } finally {
    await close();
  }
});

test('routes without response schemas may reply with any success status', async () => {
  const {send, close} = fixture();
  try {
    const response = await send('/r/unconstrained');
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {queued: true});
  } finally {
    await close();
  }
});

test('a native Response is returned as-is without schema validation', async () => {
  const {send, close} = fixture();
  try {
    const response = await send('/r/native');
    assert.equal(response.status, 207);
    assert.equal(await response.text(), 'not json');
  } finally {
    await close();
  }
});

test('an undeclared method on a declared path is not found', async () => {
  const {send, close} = fixture();
  try {
    assert.equal((await send('/r/default', {method: 'POST'})).status, 404);
  } finally {
    await close();
  }
});

function headerFixture() {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({module}) => [
      module({
        name: 'headers',
        prefix: '/h',
        routes: route => [
          route.post('/', {
            response: {201: item},
            handler: () =>
              reply(201, {id: 'n1'}, {headers: {location: '/h/n1'}}),
          }),
          route.get('/cookies', {
            response: {200: item},
            handler: () => {
              const headers = new Headers();
              headers.append('set-cookie', 'a=1; Path=/');
              headers.append('set-cookie', 'b=2; Path=/');
              headers.set('cache-control', 'no-store');
              return reply(200, {id: 'c'}, {headers});
            },
          }),
          route.get('/invalid', {
            response: {201: item},
            handler: () =>
              reply(201, {id: 1} as never, {
                headers: {location: '/x', 'set-cookie': 's=1'},
              }),
          }),
          route.get('/text', {
            handler: () =>
              reply(200, 'plain', {headers: {'content-type': 'text/plain'}}),
          }),
        ],
      }),
    ],
  });
  const send = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${origin}${path}`, init));
  const close = async () => {
    await app.close();
    await root.dispose();
  };
  return {send, close};
}

test('reply headers accompany a schema-validated body', async () => {
  const {send, close} = headerFixture();
  try {
    const created = await send('/h/', {method: 'POST'});
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('location'), '/h/n1');
    assert.deepEqual(await created.json(), {id: 'n1'});
    const cookies = await send('/h/cookies');
    assert.deepEqual(cookies.headers.getSetCookie(), [
      'a=1; Path=/',
      'b=2; Path=/',
    ]);
    assert.equal(cookies.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await cookies.json(), {id: 'c'});
  } finally {
    await close();
  }
});

test('reply headers neither bypass response validation nor override an explicit type', async () => {
  const {send, close} = headerFixture();
  try {
    const invalid = await send('/h/invalid');
    assert.equal(invalid.status, 500);
    assert.equal(invalid.headers.get('location'), null);
    assert.deepEqual(invalid.headers.getSetCookie(), []);
    const text = await send('/h/text');
    assert.equal(
      text.headers.get('content-type')?.startsWith('text/plain'),
      true,
    );
    assert.equal(await text.text(), 'plain');
  } finally {
    await close();
  }
});

test('reply rejects malformed header names when it is called', () => {
  assert.throws(
    () => reply(200, null, {headers: {'bad header': 'x'}}),
    TypeError,
  );
});
