import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SignJWT} from 'jose';
import {UnauthorizedError} from 'hyapi';
import {verifyBearer} from '../../apps/example/src/auth.ts';

const key = new TextEncoder().encode(
  'example-secret-for-tests-at-least-32-bytes',
);
const request = (authorization?: string) =>
  new Request('http://localhost/v1/users/', {
    headers: authorization ? {authorization} : {},
  });

test('Bearer verification accepts a signed subject and retains its role', async () => {
  const token = await new SignJWT({role: 'admin'})
    .setProtectedHeader({alg: 'HS256'})
    .setSubject('ada')
    .sign(key);
  const identity = await verifyBearer(request(`Bearer ${token}`), key);
  assert.equal(identity.subject, 'ada');
  assert.equal(identity.claims.role, 'admin');
});

test('Bearer verification rejects missing credentials, invalid signatures, and missing subjects', async () => {
  await assert.rejects(verifyBearer(request(), key), UnauthorizedError);
  const wrongKey = new TextEncoder().encode(
    'another-secret-for-tests-at-least-32-bytes',
  );
  const wrongSignature = await new SignJWT({})
    .setProtectedHeader({alg: 'HS256'})
    .setSubject('ada')
    .sign(wrongKey);
  await assert.rejects(
    verifyBearer(request(`Bearer ${wrongSignature}`), key),
    UnauthorizedError,
  );
  const noSubject = await new SignJWT({})
    .setProtectedHeader({alg: 'HS256'})
    .sign(key);
  await assert.rejects(
    verifyBearer(request(`Bearer ${noSubject}`), key),
    UnauthorizedError,
  );
});
