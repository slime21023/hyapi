// Enforces the layer rules of ADR 0003 §3–§5 and ADR 0004 §1 inside packages/core/src.
import { importSpecifiers } from "./imports.ts";

export interface LayerViolation {
  readonly file: string;
  readonly reason: string;
}

/** ADR 0003 §3: the layer of every Core module. Directories map as a whole. */
const LAYERS: Readonly<Record<string, number>> = {
  "base/": 0,
  "contract/": 1,
  "openapi/": 2,
  "runtime/deadline.ts": 2,
  "runtime/routing.ts": 2,
  "runtime/params.ts": 2,
  "runtime/body.ts": 2,
  "runtime/validation.ts": 2,
  "runtime/security.ts": 2,
  "runtime/problem.ts": 2,
  "runtime/health.ts": 2,
  "runtime/lifecycle.ts": 2,
  "runtime/handler.ts": 2,
  "runtime/pipeline.ts": 3,
  "runtime/respond.ts": 3,
  "runtime/events.ts": 4,
  "runtime/diagnostics.ts": 4,
  "runtime/startup.ts": 4,
  "runtime/options.ts": 4,
  "runtime/documents.ts": 4,
  "runtime/app.ts": 4,
  "runtime/mod.ts": 4,
  "deno/": 5,
};

/** The only module that may write TypeBox's process-wide format registry (ADR 0003 §5). */
const FORMAT_REGISTRAR = "runtime/app.ts";

const SRC = "packages/core/src/";

/** The layer of a path under `packages/core/src/`, or undefined when it has none. */
export function layerOf(path: string): number | undefined {
  if (!path.startsWith(SRC)) return undefined;
  const module = path.slice(SRC.length);
  if (module in LAYERS) return LAYERS[module];
  const directory = Object.keys(LAYERS).find((key) => key.endsWith("/") && module.startsWith(key));
  return directory === undefined ? undefined : LAYERS[directory];
}

function resolveRelative(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

// Module scope starts at column 0, which `deno fmt` guarantees.
const MUTABLE_BINDING = /^(?:export\s+)?(?:let|var)\s+(\w+)/;
const COLLECTION =
  /^(?:export\s+)?const\s+(\w+)\s*(?::\s*([^=]+?))?\s*=\s*new\s+(Map|Set|WeakMap|WeakSet)\b/;

/** Checks the layer edges and module-level state of one file under `packages/core/src/`. */
export function checkLayers(path: string, source: string): LayerViolation[] {
  if (!path.startsWith(SRC)) return [];
  const module = path.slice(SRC.length);
  const layer = layerOf(path);
  const violations: LayerViolation[] = [];
  const fail = (reason: string) => violations.push({ file: path, reason });
  if (layer === undefined) {
    fail(`${module} has no layer; add it to ADR 0003 §3`);
    return violations;
  }

  for (const specifier of importSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;
    const target = resolveRelative(path, specifier);
    const targetLayer = layerOf(target);
    if (targetLayer !== undefined && targetLayer > layer) {
      fail(`L${layer} ${module} may not import L${targetLayer} ${target.slice(SRC.length)}`);
    }
  }

  for (const line of source.split("\n")) {
    const binding = MUTABLE_BINDING.exec(line);
    if (binding) fail(`module-level mutable binding '${binding[1]}'`);
    const collection = COLLECTION.exec(line);
    if (collection) {
      const [, name, type = "", kind = ""] = collection;
      const readOnly = (kind === "Map" || kind === "Set") &&
        type.trim().startsWith(`Readonly${kind}`);
      if (!readOnly) {
        fail(
          `module-level ${kind} '${name}'; ` +
            (kind.startsWith("Weak")
              ? "keep it in a closure owned by the application"
              : `type it as Readonly${kind} or keep it in a closure`),
        );
      }
    }
  }
  if (module !== FORMAT_REGISTRAR && /\bFormat\.(Set|Clear|Reset)\s*\(/.test(source)) {
    fail(`only ${FORMAT_REGISTRAR} may write TypeBox's format registry`);
  }
  return violations;
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** Checks every module under `packages/core/src/`, relative to the repository root. */
export async function checkCoreLayers(root: string): Promise<LayerViolation[]> {
  const violations: LayerViolation[] = [];
  for await (const file of sourceFiles(`${root}/${SRC.slice(0, -1)}`)) {
    const path = file.slice(root.length + 1);
    violations.push(...checkLayers(path, await Deno.readTextFile(file)));
  }
  return violations;
}
