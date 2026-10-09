import { parse as parseJsonc } from "jsr:@std/jsonc@^1";
import { extname, isAbsolute, join, resolve } from "jsr:@std/path@^1";

/** One document in the `hyapi.documents` list of `deno.json`. */
export interface DocumentConfig {
  /** Names the document in output and in `--document`. */
  readonly name: string;
  /** The API module and export, as `./contracts/api.ts#api`. */
  readonly api: string;
  /** The committed files: `.json`, `.yaml`, or `.yml`; the first is the one `diff` compares. */
  readonly openapi: string | readonly string[];
}

/**
 * The `hyapi` section of a project's `deno.json`: either one document as `api` and `openapi`, or
 * several as `documents`.
 */
export interface ProjectConfig {
  readonly api?: string;
  readonly openapi?: string | readonly string[];
  readonly documents?: readonly DocumentConfig[];
}

export type DocumentFormat = "json" | "yaml";

/** One output file of a document. */
export interface Output {
  readonly path: string;
  readonly format: DocumentFormat;
}

/** One document to emit, check, or compare. */
export interface DocumentTarget {
  readonly name: string;
  readonly apiModule: string;
  readonly apiExport: string;
  /** At least one; the first is the one `diff` compares. */
  readonly outputs: readonly Output[];
}

/** The flags that select documents. */
export interface DocumentFlags {
  readonly api?: string;
  readonly out?: string;
  readonly document?: string;
}

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

function output(cwd: string, file: string): Output {
  const extension = extname(file).toLowerCase();
  if (![".json", ".yaml", ".yml"].includes(extension)) {
    throw new UsageError(`the document must end in .json, .yaml, or .yml, got '${file}'`);
  }
  return {
    path: isAbsolute(file) ? file : resolve(cwd, file),
    format: extension === ".json" ? "json" : "yaml",
  };
}

function target(cwd: string, name: string, api: unknown, openapi: unknown): DocumentTarget {
  if (typeof api !== "string" || api === "") {
    throw new UsageError(
      'no API module: add "hyapi": { "api": "./contracts/api.ts#api", "openapi": "./openapi.json" } ' +
        "to deno.json, or pass --api <module#export>",
    );
  }
  const files: unknown[] = typeof openapi === "string"
    ? [openapi]
    : Array.isArray(openapi)
    ? openapi
    : [];
  if (files.length === 0 || files.some((file) => typeof file !== "string" || file === "")) {
    throw new UsageError(
      `no document path for '${name}': set its openapi in deno.json, or pass --out <file>`,
    );
  }
  const [modulePath = "", apiExport = "api"] = api.split("#");
  return {
    name,
    apiModule: isAbsolute(modulePath) ? modulePath : resolve(cwd, modulePath),
    apiExport,
    outputs: (files as string[]).map((file) => output(cwd, file)),
  };
}

/** The targets of a `hyapi.documents` list, with unique names. */
function listedTargets(cwd: string, documents: unknown): DocumentTarget[] {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new UsageError("hyapi.documents must list at least one { name, api, openapi }");
  }
  const targets = documents.map((entry: Partial<DocumentConfig>) => {
    if (typeof entry?.name !== "string" || entry.name === "") {
      throw new UsageError("every entry of hyapi.documents needs a name");
    }
    return target(cwd, entry.name, entry.api, entry.openapi);
  });
  const names = targets.map((t) => t.name);
  const repeated = names.find((name, i) => names.indexOf(name) !== i);
  if (repeated !== undefined) throw new UsageError(`hyapi.documents lists '${repeated}' twice`);
  return targets;
}

/** Keeps the document that `--document` names. */
function select(targets: DocumentTarget[], name: string | undefined): DocumentTarget[] {
  if (name === undefined) return targets;
  const selected = targets.filter((t) => t.name === name);
  if (selected.length > 0) return selected;
  throw new UsageError(
    `no document named '${name}'; configured: ${targets.map((t) => t.name).join(", ")}`,
  );
}

/**
 * Resolves the documents to work on from `deno.json` and command flags. `--api` and `--out`
 * describe one document directly and win over a single configured document; `--document` selects
 * one document of `hyapi.documents`.
 */
export async function resolveDocuments(
  cwd: string,
  flags: DocumentFlags,
): Promise<DocumentTarget[]> {
  const config = (await readConfigFile(cwd))?.hyapi as ProjectConfig | undefined;
  const listed = config?.documents !== undefined;
  if (flags.api !== undefined || flags.out !== undefined) {
    if (flags.document !== undefined) {
      throw new UsageError("--document selects a configured document; omit --api and --out");
    }
    const single = listed ? undefined : config;
    return [target(cwd, "default", flags.api ?? single?.api, flags.out ?? single?.openapi)];
  }
  if (listed && (config?.api !== undefined || config?.openapi !== undefined)) {
    throw new UsageError("use either hyapi.api and hyapi.openapi, or hyapi.documents, not both");
  }
  const targets = listed
    ? listedTargets(cwd, config?.documents)
    : [target(cwd, "default", config?.api, config?.openapi)];
  return select(targets, flags.document);
}
