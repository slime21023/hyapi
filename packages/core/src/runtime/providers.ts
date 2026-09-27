import { ConfigurationError } from "../errors.ts";
import { collectError, Scope } from "./scope.ts";
import {
  formatContractVersion,
  isCompatibleContractVersion,
  type Port,
  type PortProvider,
} from "../port.ts";

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
}
