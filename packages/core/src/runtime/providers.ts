import type { HealthReport, Port, PortProvider, ProviderHealth } from "../types.ts";
import { ConfigurationError } from "../errors.ts";
import { collectError, Scope } from "./scope.ts";
import { formatContractVersion, isCompatibleContractVersion } from "../port.ts";

const PROVIDER_HEALTH_TIMEOUT_MS = 5_000;

function isProviderHealth(value: unknown): value is ProviderHealth {
  if (typeof value !== "object" || value === null) return false;
  if (!("status" in value) || !("provider" in value)) return false;
  return (value.status === "healthy" || value.status === "degraded" ||
    value.status === "unhealthy") && typeof value.provider === "string";
}

export class ProviderRegistry {
  readonly #providers = new Map<string, PortProvider<unknown>>();

  register(providers: readonly PortProvider<unknown>[]): void {
    for (const provider of providers) {
      if (this.#providers.has(provider.port.id)) {
        throw new ConfigurationError(`Port '${provider.port.id}' is already provided.`);
      }
      this.#providers.set(provider.port.id, provider);
    }
  }

  use<T>(port: Port<T>): T {
    const provider = this.#providers.get(port.id);
    if (!provider) {
      throw new ConfigurationError(`Port '${port.id}' is required but no provider is registered.`);
    }
    if (!isCompatibleContractVersion(port.version, provider.port.version)) {
      throw new ConfigurationError(
        `Port '${port.id}' requires version ${
          formatContractVersion(port.version)
        }, but provider has version ${formatContractVersion(provider.port.version)}.`,
      );
    }
    return provider.value as T;
  }

  /** Connects providers in registration order; once all connect, they close with `owner`. */
  async connect(owner: Scope, rollbackTimeoutMs: number): Promise<void> {
    const connected = new Scope("Provider shutdown failed.");
    try {
      for (const provider of this.#providers.values()) {
        await provider.lifecycle?.connect?.();
        connected.defer(() => provider.lifecycle?.close?.());
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        await connected.close(Date.now() + rollbackTimeoutMs);
      } catch (closeError) {
        collectError(rollbackErrors, closeError);
      }
      throw new AggregateError([error, ...rollbackErrors], "Provider connection failed.", {
        cause: error,
      });
    }
    owner.defer((deadline) => connected.close(deadline));
  }

  async health(): Promise<HealthReport> {
    const providers = await Promise.all(
      [...this.#providers.values()].map((provider) => this.#providerHealth(provider)),
    );
    const status = providers.some((provider) => provider.status === "unhealthy")
      ? "unhealthy"
      : providers.some((provider) => provider.status === "degraded")
      ? "degraded"
      : "healthy";
    return { status, providers };
  }

  async #providerHealth(provider: PortProvider<unknown>): Promise<ProviderHealth> {
    const id = provider.port.id;
    const lifecycle = provider.lifecycle;
    if (!lifecycle?.health) return { status: "healthy", provider: id };
    const { promise: timedOut, resolve } = Promise.withResolvers<ProviderHealth>();
    const timer = setTimeout(() =>
      resolve({
        status: "unhealthy",
        provider: id,
        detail: `Health check timed out after ${PROVIDER_HEALTH_TIMEOUT_MS} ms.`,
      }), PROVIDER_HEALTH_TIMEOUT_MS);
    try {
      const report: unknown = await Promise.race([
        Promise.resolve().then(() => lifecycle.health?.()),
        timedOut,
      ]);
      if (!isProviderHealth(report)) {
        return {
          status: "unhealthy",
          provider: id,
          detail: "Health check returned an invalid report.",
        };
      }
      return report;
    } catch (error) {
      return {
        status: "unhealthy",
        provider: id,
        detail: error instanceof Error ? error.message : "Health check failed.",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
