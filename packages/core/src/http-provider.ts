import { ConfigurationError } from "./errors.ts";
import {
  createHttpContractClient,
  type HttpContract,
  type HttpContractClient,
  type HttpContractClientOptions,
  type HttpContractRoutes,
  resolveContractUrl,
} from "./http-contract.ts";
import { type Port, type PortProvider, providePort, type ProviderHealth } from "./types.ts";
import { formatContractVersion, isCompatibleContractVersion } from "./version.ts";

export interface HttpPortOptions<TPort, TRoutes extends HttpContractRoutes>
  extends HttpContractClientOptions {
  readonly contract: HttpContract<TRoutes>;
  readonly healthPath?: string;
  adapt(client: HttpContractClient<TRoutes>): TPort;
}

export function provideHttp<TPort, TRoutes extends HttpContractRoutes>(
  port: Port<TPort>,
  options: HttpPortOptions<TPort, TRoutes>,
): PortProvider<TPort> {
  if (
    options.contract.name !== port.id ||
    !isCompatibleContractVersion(port.version, options.contract.version)
  ) {
    throw new ConfigurationError(
      `HTTP contract '${options.contract.name}' version ${
        formatContractVersion(options.contract.version)
      } does not match port '${port.id}' version ${formatContractVersion(port.version)}.`,
    );
  }
  const healthPath = options.healthPath;
  if (healthPath && !healthPath.startsWith("/")) {
    throw new ConfigurationError(
      `HTTP provider for port '${port.id}' healthPath must start with '/'.`,
    );
  }
  const provider = options.adapt(createHttpContractClient(options.contract, options));
  const health = async (): Promise<ProviderHealth> => {
    if (!healthPath) return { status: "healthy", provider: port.id };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await (options.fetch ?? fetch)(
        resolveContractUrl(options.baseUrl, healthPath),
        { method: "GET", signal: controller.signal },
      );
      await response.body?.cancel().catch(() => undefined);
      return response.ok ? { status: "healthy", provider: port.id } : {
        status: "unhealthy",
        provider: port.id,
        detail: `Health endpoint returned ${response.status}.`,
      };
    } catch (error) {
      return {
        status: "unhealthy",
        provider: port.id,
        detail: error instanceof Error ? error.message : "Health endpoint request failed.",
      };
    } finally {
      clearTimeout(timer);
    }
  };
  return providePort<TPort>(
    { id: port.id, version: options.contract.version },
    provider,
    { health },
  );
}
