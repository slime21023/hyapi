/** Defines transport-level HTTP contracts independently of module Port behavior. @module */

import { ConfigurationError } from "../errors.ts";
import { type ContractVersion, validateContractVersion } from "../port.ts";
import type {
  HttpMethod,
  ResponseSchemas,
  RouteMetadata,
  RouteRequestSchemas,
  Schema,
} from "../types.ts";

/** Typed HTTP route shared by a client and its server registration. */
export interface HttpContractRoute<
  TParams extends Schema | undefined = Schema | undefined,
  TQuery extends Schema | undefined = Schema | undefined,
  TBody extends Schema | undefined = Schema | undefined,
  TResponse extends ResponseSchemas = ResponseSchemas,
  TBodyRequired extends boolean = true,
> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly request?: RouteRequestSchemas<TParams, TQuery, TBody, TBodyRequired>;
  readonly responses: TResponse;
  readonly metadata?: RouteMetadata;
}

/** Non-generic HTTP contract route shape used by contract collections. */
export type AnyHttpContractRoute = HttpContractRoute<
  Schema | undefined,
  Schema | undefined,
  Schema | undefined,
  ResponseSchemas,
  boolean
>;

/** Named HTTP contract routes. Each key becomes the default OpenAPI operation ID. */
export type HttpContractRoutes = Readonly<Record<string, AnyHttpContractRoute>>;

/** Versioned HTTP API description shared by callers and handlers. */
export interface HttpContract<TRoutes extends HttpContractRoutes = HttpContractRoutes> {
  readonly name: string;
  readonly version: ContractVersion;
  readonly routes: TRoutes;
}

/** Validates and returns a versioned HTTP contract. */
export function defineHttpContract<TRoutes extends HttpContractRoutes>(
  contract: HttpContract<TRoutes>,
): HttpContract<TRoutes> {
  validateContractVersion(contract.version);
  for (const [key, route] of Object.entries(contract.routes)) {
    if (!route.path.startsWith("/")) {
      throw new ConfigurationError(
        `HTTP contract '${contract.name}' route '${key}' path must start with '/'.`,
      );
    }
  }
  return contract;
}
