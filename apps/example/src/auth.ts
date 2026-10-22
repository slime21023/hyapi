import {jwtVerify, type JWTPayload} from 'jose';
import {UnauthorizedError} from 'hyapi';
import type {ExampleContainer} from './container.ts';

export interface Identity {
  readonly subject: string;
  readonly claims: JWTPayload;
}

export async function verifyBearer(
  request: Request,
  key: Uint8Array,
): Promise<Identity> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedError();
  try {
    const {payload} = await jwtVerify(authorization.slice(7), key, {
      algorithms: ['HS256'],
    });
    if (!payload.sub) throw new UnauthorizedError();
    return {subject: payload.sub, claims: payload};
  } catch {
    throw new UnauthorizedError('Invalid bearer token.');
  }
}

export function authenticate(
  request: Request,
  root: ExampleContainer,
): Promise<Identity> {
  return verifyBearer(request, root.get('jwtKey'));
}
