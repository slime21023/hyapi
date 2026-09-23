import { ConfigurationError } from "./errors.ts";
import type { ContractVersion } from "./types.ts";

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
