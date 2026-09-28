/** Defines typed module boundaries and provider compatibility rules. @module */

import type { MaybePromise } from "./types.ts";
import { ConfigurationError } from "./errors.ts";

/** Major/minor version used to determine Port compatibility. */
export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
}

/** Typed capability required or provided by a module. */
export interface Port<T> {
  readonly id: string;
  readonly version: ContractVersion;
  readonly __type?: T;
}

/** Optional lifecycle owned by a Port provider. */
export interface ProviderLifecycle {
  connect?(): MaybePromise<void>;
  close?(): MaybePromise<void>;
}

/** Concrete value supplied for a Port, optionally with connection lifecycle hooks. */
export interface PortProvider<T> {
  readonly port: Port<T>;
  readonly value: T;
  readonly lifecycle?: ProviderLifecycle;
}

/** Runtime assertion that verifies a provider satisfies a Port's expected behavior. */
export interface PortContract<T> {
  readonly name: string;
  verify(provider: T): MaybePromise<void>;
}

export function validateContractVersion(version: ContractVersion): void {
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

/** Returns whether a provider supports the required major/minor contract version. */
export function isCompatibleContractVersion(
  required: ContractVersion,
  provided: ContractVersion,
): boolean {
  return required.major === provided.major && provided.minor >= required.minor;
}

/** Formats a contract version as `major.minor`. */
export function formatContractVersion(version: ContractVersion): string {
  return `${version.major}.${version.minor}`;
}

/**
 * Defines a typed capability shared between modules.
 * @param id Stable capability identifier.
 * @param version Required compatibility version.
 */
export function definePort<T>(
  id: string,
  version: ContractVersion = { major: 1, minor: 0 },
): Port<T> {
  validateContractVersion(version);
  return { id, version };
}

/** Associates a concrete value and optional lifecycle with a Port. */
export const providePort = <T>(
  port: Port<T>,
  value: T,
  lifecycle?: ProviderLifecycle,
): PortProvider<T> => ({
  port,
  value,
  ...(lifecycle ? { lifecycle } : {}),
});

/** Creates a named runtime assertion for a Port provider. */
export function definePortContract<T>(
  name: string,
  verify: (provider: T) => MaybePromise<void>,
): PortContract<T> {
  return { name, verify };
}

/** Verifies one provider and preserves its failure as the error cause. */
export async function verifyPortContract<T>(contract: PortContract<T>, provider: T): Promise<void> {
  try {
    await contract.verify(provider);
  } catch (error) {
    throw new Error(`Port contract '${contract.name}' failed.`, { cause: error });
  }
}

/** Verifies every provider against the same contract. */
export async function verifyPortContracts<T>(
  contract: PortContract<T>,
  providers: readonly T[],
): Promise<void> {
  for (const provider of providers) await verifyPortContract(contract, provider);
}
