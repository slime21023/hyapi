import type { MaybePromise } from "./types.ts";

export interface PortContract<T> {
  readonly name: string;
  verify(provider: T): MaybePromise<void>;
}

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
