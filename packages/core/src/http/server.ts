import { ConfigurationError } from "../errors.ts";
import type {
  MaybePromise,
  RequestContext,
  RouteDefinition,
  RouteGroupApi,
  Schema,
} from "../types.ts";
import type {
  AnyHttpContractRoute,
  HttpContract,
  HttpContractRoute,
  HttpContractRoutes,
} from "./contract.ts";

export type HttpContractHandler<TRoute extends AnyHttpContractRoute> = TRoute extends
  HttpContractRoute<
    infer TParams,
    infer TQuery,
    infer TBody,
    infer _TResponse,
    infer TBodyRequired
  > ? (context: RequestContext<TParams, TQuery, TBody, TBodyRequired>) => MaybePromise<unknown>
  : never;

export type HttpContractHandlers<TRoutes extends HttpContractRoutes> = {
  readonly [TName in keyof TRoutes]: HttpContractHandler<TRoutes[TName]>;
};

export function registerHttpContract<TRoutes extends HttpContractRoutes>(
  api: RouteGroupApi,
  contract: HttpContract<TRoutes>,
  handlers: HttpContractHandlers<TRoutes>,
): void {
  for (
    const [name, contractRoute] of Object.entries(contract.routes) as [
      keyof TRoutes & string,
      AnyHttpContractRoute,
    ][]
  ) {
    const handler = handlers[name];
    if (typeof handler !== "function") {
      throw new ConfigurationError(
        `HTTP contract '${contract.name}' has no handler for route '${name}'.`,
      );
    }
    const metadata = {
      ...contractRoute.metadata,
      operationId: contractRoute.metadata?.operationId ?? name,
    };
    api.route({
      ...contractRoute,
      metadata,
      handler,
    } as unknown as RouteDefinition<Schema, Schema, Schema>);
  }
}
