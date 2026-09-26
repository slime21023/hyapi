import type { MaybePromise } from "./types.ts";
import { ConfigurationError } from "./errors.ts";

export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
}

export interface Port<T> {
  readonly id: string;
  readonly version: ContractVersion;
  readonly __type?: T;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** A provider's own health result; its port ID is assigned by the registry. */
export interface ProviderHealthCheck {
  readonly status: HealthStatus;
  readonly detail?: string;
}

/** A health result associated with the port that supplied it. */
export interface ProviderHealth extends ProviderHealthCheck {
  readonly provider: string;
}

export interface ProviderLifecycle {
  connect?(): MaybePromise<void>;
  health?(): MaybePromise<ProviderHealthCheck>;
  close?(): MaybePromise<void>;
}

export interface PortProvider<T> {
  readonly port: Port<T>;
  readonly value: T;
  readonly lifecycle?: ProviderLifecycle;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly providers: readonly ProviderHealth[];
}

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

export function isCompatibleContractVersion(
  required: ContractVersion,
  provided: ContractVersion,
): boolean {
  return required.major === provided.major && provided.minor >= required.minor;
}

export function formatContractVersion(version: ContractVersion): string {
  return `${version.major}.${version.minor}`;
}

export function definePort<T>(
  id: string,
  version: ContractVersion = { major: 1, minor: 0 },
): Port<T> {
  validateContractVersion(version);
  return { id, version };
}

export const providePort = <T>(
  port: Port<T>,
  value: T,
  lifecycle?: ProviderLifecycle,
): PortProvider<T> => ({
  port,
  value,
  ...(lifecycle ? { lifecycle } : {}),
});

export function definePortContract<T>(
  name: string,
  verify: (provider: T) => MaybePromise<void>,
): PortContract<T> {
  return { name, verify };
}

export async function verifyPortContract<T>(contract: PortContract<T>, provider: T): Promise<void> {
  try {
    await contract.verify(provider);
  } catch (error) {
    throw new Error(`Port contract '${contract.name}' failed.`, { cause: error });
  }
}

export async function verifyPortContracts<T>(
  contract: PortContract<T>,
  providers: readonly T[],
): Promise<void> {
  for (const provider of providers) await verifyPortContract(contract, provider);
}
