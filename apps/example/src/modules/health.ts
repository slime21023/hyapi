import * as v from 'valibot';
import {
  HttpError,
  type ModuleBuilder,
  type ModuleDefinition,
  type RouteApi,
} from 'hyapi';
import type {ExampleContainer} from '../container.ts';
import {streamResponse} from '../stream.ts';

function liveRoute(route: RouteApi<ExampleContainer, undefined>) {
  return route.get('/live', {
    response: v.object({status: v.literal('ok')}),
    summary: 'Liveness',
    tags: ['Health'],
    handler: () => ({status: 'ok' as const}),
  });
}

function readyRoute(route: RouteApi<ExampleContainer, undefined>) {
  return route.get('/ready', {
    response: v.object({status: v.literal('ok')}),
    summary: 'PostgreSQL readiness',
    tags: ['Health'],
    async handler({root}) {
      try {
        await root.get('database')`SELECT 1`;
      } catch {
        throw new HttpError(
          503,
          'PostgreSQL is unavailable.',
          'DATABASE_UNAVAILABLE',
        );
      }
      return {status: 'ok' as const};
    },
  });
}

function streamRoute(route: RouteApi<ExampleContainer, undefined>) {
  return route.get('/stream', {
    summary: 'Finite heartbeat stream',
    tags: ['Health'],
    handler: streamResponse,
  });
}

export function healthModule(
  module: ModuleBuilder<ExampleContainer>,
): ModuleDefinition {
  return module({
    name: 'health',
    prefix: '/health',
    routes: route => [liveRoute(route), readyRoute(route), streamRoute(route)],
  });
}
