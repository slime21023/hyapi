// Enforces that the file-level import graph of packages/ is acyclic, so the library is at least a
// directed acyclic graph at every granularity. Type-only imports, re-exports, and dynamic imports
// count, because a cycle of types still couples the modules in it.
import { importSpecifiers } from "./imports.ts";
import { readSources, resolveRelative } from "./repository.ts";

/** Package entry points that packages import by name, mapped to their files. */
const PACKAGE_FILES: Readonly<Record<string, string>> = {
  "@hyapi/core": "packages/core/mod.ts",
  "@hyapi/core/contract": "packages/core/contract.ts",
  "@hyapi/core/openapi": "packages/core/openapi.ts",
  "@hyapi/core/deno": "packages/core/deno.ts",
  "@hyapi/openapi-diff": "packages/openapi-diff/mod.ts",
  "@hyapi/cli": "packages/cli/mod.ts",
};

/** The repository file that an import specifier refers to, or undefined for external packages. */
function targetFile(from: string, specifier: string): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveRelative(from, specifier);
  }
  const plugin = specifier.match(/^@hyapi\/(plugin-[a-z-]+)$/);
  if (plugin) return `packages/${plugin[1]}/mod.ts`;
  return PACKAGE_FILES[specifier];
}

/** Builds the import graph of the given sources, keyed by repository-relative path. */
export function importGraph(sources: ReadonlyMap<string, string>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [path, source] of sources) {
    const targets = importSpecifiers(source)
      .map((specifier) => targetFile(path, specifier))
      .filter((target): target is string => target !== undefined && sources.has(target));
    graph.set(path, [...new Set(targets)]);
  }
  return graph;
}

/** What one depth-first search tracks. */
interface Search {
  readonly graph: ReadonlyMap<string, readonly string[]>;
  /** 1 while a node is on the current path, 2 once all its descendants are explored. */
  readonly state: Map<string, 1 | 2>;
  readonly path: string[];
  readonly cycles: string[][];
}

function visit(node: string, search: Search): void {
  search.state.set(node, 1);
  search.path.push(node);
  for (const next of search.graph.get(node) ?? []) {
    const seen = search.state.get(next);
    // A node still on the path closes a cycle back to it.
    if (seen === 1) search.cycles.push([...search.path.slice(search.path.indexOf(next)), next]);
    else if (seen === undefined) visit(next, search);
  }
  search.path.pop();
  search.state.set(node, 2);
}

/** Returns one path for every cycle that a depth-first search finds, each ending where it starts. */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const search: Search = { graph, state: new Map(), path: [], cycles: [] };
  for (const node of [...graph.keys()].sort()) {
    if (!search.state.has(node)) visit(node, search);
  }
  return search.cycles;
}

/** Finds the import cycles among the files under `packages/`, relative to the repository root. */
export async function checkRepositoryCycles(root: string): Promise<string[][]> {
  return findCycles(importGraph(await readSources(root, "packages")));
}
