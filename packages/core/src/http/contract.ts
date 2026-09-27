import { ConfigurationError } from "../errors.ts";
import type { ContractVersion } from "../port.ts";
import type {
  HttpMethod,
  ResponseSchemas,
  RouteMetadata,
  RouteRequestSchemas,
  Schema,
} from "../types.ts";

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

export type AnyHttpContractRoute = HttpContractRoute<
  Schema | undefined,
  Schema | undefined,
  Schema | undefined,
  ResponseSchemas,
  boolean
>;

export type HttpContractRoutes = Readonly<Record<string, AnyHttpContractRoute>>;

export interface HttpContract<TRoutes extends HttpContractRoutes = HttpContractRoutes> {
  readonly name: string;
  readonly version: ContractVersion;
  readonly routes: TRoutes;
}

function validateHttpContractVersion(version: ContractVersion): void {
  if (
    typeof version !== "object" || version === null ||
    !Number.isInteger(version.major) || version.major < 0 ||
    !Number.isInteger(version.minor) || version.minor < 0
  ) {
    throw new ConfigurationError(
      `Invalid contract version '${
        JSON.stringify(version)
      }': major and minor must be non-negative integers.`,
    );
  }
}

export function isCompatibleHttpContractVersion(
  required: ContractVersion,
  provided: ContractVersion,
): boolean {
  return required.major === provided.major && provided.minor >= required.minor;
}

export function formatHttpContractVersion(version: ContractVersion): string {
  return `${version.major}.${version.minor}`;
}

export function defineHttpContract<TRoutes extends HttpContractRoutes>(
  contract: HttpContract<TRoutes>,
): HttpContract<TRoutes> {
  validateHttpContractVersion(contract.version);
  for (const [key, route] of Object.entries(contract.routes)) {
    if (!route.path.startsWith("/")) {
      throw new ConfigurationError(
        `HTTP contract '${contract.name}' route '${key}' path must start with '/'.`,
      );
    }
  }
  return contract;
}
