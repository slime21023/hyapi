// Enforces the inner boundaries of the contract component (ADR 0004 §2–§3): the runtime and the
// emitter reach the compiler only through its fixed entry points, and dependencies inside the
// component point one way.
import { readSources, resolveRelative } from "./repository.ts";

export interface BoundaryViolation {
  readonly file: string;
  readonly target: string;
  readonly reason: string;
}

const SRC = "packages/core/src/";
const CONTRACT = `${SRC}contract/`;

/** Modules that consumers may import values from. */
const VALUE_ENTRIES: ReadonlySet<string> = new Set([
  "model.ts",
  "compile/compile.ts",
  "compile/diagnostics.ts",
  "declare/schema.ts",
]);

/** True for modules that consumers may import types from. */
const typeEntry = (module: string) =>
  VALUE_ENTRIES.has(module) || module === "infer.ts" || module.startsWith("declare/");

/** What each part of the component must not import, by path prefix inside `contract/`. */
const FORBIDDEN: readonly { readonly from: string; readonly to: readonly string[] }[] = [
  { from: "model.ts", to: ["declare/", "compile/", "infer.ts"] },
  { from: "declare/", to: ["compile/", "infer.ts"] },
  { from: "infer.ts", to: ["compile/"] },
];

interface Import {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/** Static imports and re-exports, with whether every imported name is a type. */
export function imports(source: string): Import[] {
  const statement =
    /^\s*(?:import|export)\s+(type\s+)?(?:(\{[^}]*\})|[^'";{]*?)?\s*(?:from\s*)?["']([^"']+)["']/gm;
  const found: Import[] = [];
  for (const [, typeKeyword, braces, specifier] of source.matchAll(statement)) {
    const names = braces?.slice(1, -1).split(",").map((name) => name.trim()).filter(Boolean) ?? [];
    const allTypes = names.length > 0 && names.every((name) => name.startsWith("type "));
    found.push({ specifier: specifier!, typeOnly: Boolean(typeKeyword) || allTypes });
  }
  return found;
}

/** Checks the contract imports of one file under `packages/core/src/`. */
export function checkContractBoundaries(path: string, source: string): BoundaryViolation[] {
  if (!path.startsWith(SRC)) return [];
  const consumer = /^packages\/core\/src\/(runtime|openapi)\//.test(path);
  const inside = path.startsWith(CONTRACT) ? path.slice(CONTRACT.length) : undefined;
  const violations: BoundaryViolation[] = [];
  for (const { specifier, typeOnly } of imports(source)) {
    if (!specifier.startsWith(".")) continue;
    const target = resolveRelative(path, specifier);
    if (!target.startsWith(CONTRACT)) continue;
    const module = target.slice(CONTRACT.length);
    const fail = (reason: string) => violations.push({ file: path, target, reason });
    if (consumer && !(typeOnly ? typeEntry(module) : VALUE_ENTRIES.has(module))) {
      fail(
        typeEntry(module)
          ? `contract/${module} may only be imported for types`
          : `contract/${module} is private to the contract compiler; use model.ts, ` +
            "compile/compile.ts, compile/diagnostics.ts, or the declaration types",
      );
    }
    if (inside === undefined) continue;
    const rule = FORBIDDEN.find((r) => inside.startsWith(r.from));
    if (rule?.to.some((prefix) => module.startsWith(prefix))) {
      fail(`contract/${inside} may not import contract/${module}`);
    }
  }
  return violations;
}

/** Checks every module under `packages/core/src/`, relative to the repository root. */
export async function checkRepositoryContractBoundaries(
  root: string,
): Promise<BoundaryViolation[]> {
  const sources = await readSources(root, SRC.slice(0, -1));
  return [...sources].flatMap(([path, source]) => checkContractBoundaries(path, source));
}
