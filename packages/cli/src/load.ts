import { toFileUrl } from "jsr:@std/path@^1";
import type { Api } from "@hyapi/core/contract";
import { UsageError } from "./config.ts";

/** Imports the API module and returns its `defineApi` export. */
export async function loadApi(modulePath: string, exportName: string): Promise<Api> {
  let module: Record<string, unknown>;
  try {
    module = await import(toFileUrl(modulePath).href);
  } catch (error) {
    throw new UsageError(`cannot load ${modulePath}: ${(error as Error).message}`);
  }
  const api = module[exportName] as { kind?: unknown } | undefined;
  if (api?.kind !== "hyapi.api") {
    throw new UsageError(`${modulePath} does not export a defineApi value named '${exportName}'`);
  }
  return api as Api;
}
