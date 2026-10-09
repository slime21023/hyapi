import { parse as parseJsonc } from "jsr:@std/jsonc@^1";
import { extname, isAbsolute, join, resolve } from "jsr:@std/path@^1";

/** The `hyapi` section of a project's `deno.json`. */
export interface ProjectConfig {
  /** The API module and export, as `./contracts/api.ts#api`. */
  readonly api: string;
  /** The committed OpenAPI document; `.json`, `.yaml`, or `.yml`. */
  readonly openapi: string;
}

export type DocumentFormat = "json" | "yaml";

export class UsageError extends Error {
  override name = "UsageError";
}

/** A file's text, or undefined when it does not exist. */
async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function readConfigFile(cwd: string): Promise<Record<string, unknown> | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await readIfExists(join(cwd, name));
    if (text !== undefined) return parseJsonc(text) as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Resolves the API module and the document path from `deno.json` and command flags. Flags win
 * over the configuration file.
 */
export async function resolveProject(
  cwd: string,
  flags: { readonly api?: string; readonly out?: string },
): Promise<{ apiModule: string; apiExport: string; documentPath: string; format: DocumentFormat }> {
  const config = (await readConfigFile(cwd))?.hyapi as Partial<ProjectConfig> | undefined;
  const api = flags.api ?? config?.api;
  const out = flags.out ?? config?.openapi;
  if (typeof api !== "string" || api === "") {
    throw new UsageError(
      'no API module: add "hyapi": { "api": "./contracts/api.ts#api", "openapi": "./openapi.json" } ' +
        "to deno.json, or pass --api <module#export>",
    );
  }
  if (typeof out !== "string" || out === "") {
    throw new UsageError("no document path: set hyapi.openapi in deno.json, or pass --out <file>");
  }
  const [modulePath = "", apiExport = "api"] = api.split("#");
  const extension = extname(out).toLowerCase();
  if (![".json", ".yaml", ".yml"].includes(extension)) {
    throw new UsageError(`the document must end in .json, .yaml, or .yml, got '${out}'`);
  }
  return {
    apiModule: isAbsolute(modulePath) ? modulePath : resolve(cwd, modulePath),
    apiExport,
    documentPath: isAbsolute(out) ? out : resolve(cwd, out),
    format: extension === ".json" ? "json" : "yaml",
  };
}
