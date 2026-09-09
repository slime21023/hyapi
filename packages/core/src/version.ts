import type { ContractVersion, PortVersion } from "./types.ts";

export function normalizeContractVersion(version: PortVersion): ContractVersion {
  return typeof version === "number" ? { major: version, minor: 0 } : version;
}

export function isCompatibleContractVersion(required: PortVersion, provided: PortVersion): boolean {
  const requiredVersion = normalizeContractVersion(required);
  const providedVersion = normalizeContractVersion(provided);
  return requiredVersion.major === providedVersion.major &&
    providedVersion.minor >= requiredVersion.minor;
}

export function formatContractVersion(version: PortVersion): string {
  const normalized = normalizeContractVersion(version);
  return `${normalized.major}.${normalized.minor}`;
}
