import { ConfigurationError } from "../errors.ts";
import {
  createHttpContractClient,
  formatHttpContractVersion,
  type HttpContract,
  type HttpContractClient,
  type HttpContractClientOptions,
  type HttpContractRoutes,
  isCompatibleHttpContractVersion,
  resolveContractUrl,
} from "./contract.ts";
import type { HealthCheck } from "../health.ts";
import { type Port, type PortProvider, providePort } from "../port.ts";
import { MAX_TIMER_MS } from "../runtime/timers.ts";

export interface HttpPortOptions<TPort, TRoutes extends HttpContractRoutes>
  extends HttpContractClientOptions {
  readonly contract: HttpContract<TRoutes>;
  adapt(client: HttpContractClient<TRoutes>): TPort;
}

export interface HttpHealthCheckOptions
  extends Pick<HttpContractClientOptions, "baseUrl" | "fetch" | "timeoutMs"> {
  readonly name: string;
  readonly path: string;
}

export function provideHttp<TPort, TRoutes extends HttpContractRoutes>(
  port: Port<TPort>,
  options: HttpPortOptions<TPort, TRoutes>,
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
  const provider = options.adapt(createHttpContractClient(options.contract, options));
  return providePort<TPort>(
    { id: port.id, version: options.contract.version },
    provider,
  );
}

export function createHttpHealthCheck(options: HttpHealthCheckOptions): HealthCheck {
  if (!options.path.startsWith("/")) {
    throw new ConfigurationError(`HTTP health check '${options.name}' path must start with '/'.`);
  }
  if (
    !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMER_MS
  ) {
    throw new ConfigurationError(
      "HTTP health checks require a positive timeoutMs of at most 2147483647.",
    );
  }
  return {
    name: options.name,
    check: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await (options.fetch ?? fetch)(
          resolveContractUrl(options.baseUrl, options.path),
          { method: "GET", signal: controller.signal },
        );
        await response.body?.cancel().catch(() => undefined);
        return response.ok ? { status: "healthy" } : {
          status: "unhealthy",
          detail: `Health endpoint returned ${response.status}.`,
        };
      } catch (error) {
        return {
          status: "unhealthy",
          detail: error instanceof Error ? error.message : "Health endpoint request failed.",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
