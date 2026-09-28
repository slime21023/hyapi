/** Adapts a compatible HTTP contract into a module Port provider. @module */

import { ConfigurationError } from "../errors.ts";
import {
  formatHttpContractVersion,
  type HttpContract,
  isCompatibleHttpContractVersion,
} from "./contract.ts";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "./client.ts";
import { type Port, type PortProvider, providePort } from "../port.ts";

/** HTTP contract and adapter used to implement a module Port remotely. */
export interface HttpPortOptions<TPort> extends HttpClientOptions {
  readonly contract: HttpContract;
  adapt(client: HttpClient): TPort;
}

/** Creates a Port provider after checking HTTP contract identity and version compatibility. */
export function provideHttp<TPort>(
  port: Port<TPort>,
  options: HttpPortOptions<TPort>,
): PortProvider<TPort> {
  if (
    options.contract.name !== port.id ||
    !isCompatibleHttpContractVersion(port.version, options.contract.version)
  ) {
    throw new ConfigurationError(
      `HTTP contract '${options.contract.name}' version ${
        formatHttpContractVersion(options.contract.version)
      } does not match port '${port.id}' version ${formatHttpContractVersion(port.version)}.`,
    );
  }
  const provider = options.adapt(createHttpClient(options));
  return providePort<TPort>(
    { id: port.id, version: options.contract.version },
    provider,
  );
}
