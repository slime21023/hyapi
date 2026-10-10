// Enforces narrow internal interfaces (Review 0002 I2): every export of an internal module is
// imported by another module in packages/, or re-exported by one. Public entry points are exempt;
// their exports are the public API, which the public API snapshot governs.
import ts from "typescript";
import { readSources, resolveRelative } from "./repository.ts";

export interface UnusedExport {
  readonly file: string;
  readonly name: string;
}

/** The modules whose exports are the public API. */
export function isPublicEntry(path: string): boolean {
  return /^packages\/core\/(mod|contract|openapi|deno)\.ts$/.test(path) ||
    /^packages\/[^/]+\/mod\.ts$/.test(path);
}

interface ModuleInfo {
  /** Names this module exports from its own declarations or export lists. */
  readonly exports: string[];
  /** Imported or re-exported names per target module; "*" when every name is used. */
  readonly uses: Map<string, Set<string>>;
}

function exportedNames(statement: ts.Statement, sf: ts.SourceFile): string[] {
  if (ts.isExportDeclaration(statement)) {
    // A local export list; re-exports from another module are uses, not own exports.
    if (statement.moduleSpecifier || !statement.exportClause) return [];
    if (!ts.isNamedExports(statement.exportClause)) return [];
    return statement.exportClause.elements.map((e) => e.name.text);
  }
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((d) => d.name.getText(sf));
  }
  const name = (statement as { name?: ts.Identifier }).name;
  return name ? [name.text] : [];
}

/** The names that one import or re-export statement takes from its target module. */
function usedNames(statement: ts.Statement): string[] | undefined {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return ["*"];
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) return ["*"];
    const names = bindings && ts.isNamedImports(bindings)
      ? bindings.elements.map((e) => (e.propertyName ?? e.name).text)
      : [];
    return clause.name ? [...names, "default"] : names;
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) return ["*"];
    return clause.elements.map((e) => (e.propertyName ?? e.name).text);
  }
  return undefined;
}

/** Reads the exports of one module and the names it takes from others. */
export function moduleInfo(path: string, source: string): ModuleInfo {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const exports: string[] = [];
  const uses = new Map<string, Set<string>>();
  for (const statement of sf.statements) {
    exports.push(...exportedNames(statement, sf));
    const names = usedNames(statement);
    const specifier = (statement as { moduleSpecifier?: ts.Expression }).moduleSpecifier;
    if (!names || !specifier || !ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.startsWith(".")) continue;
    const target = resolveRelative(path, specifier.text);
    const set = uses.get(target) ?? new Set<string>();
    names.forEach((name) => set.add(name));
    uses.set(target, set);
  }
  return { exports, uses };
}

/** Finds the exports of internal modules that no other module imports or re-exports. */
export function findUnusedExports(sources: ReadonlyMap<string, string>): UnusedExport[] {
  const modules = new Map([...sources].map(([path, source]) => [path, moduleInfo(path, source)]));
  const used = new Map<string, Set<string>>();
  for (const info of modules.values()) {
    for (const [target, names] of info.uses) {
      const set = used.get(target) ?? new Set<string>();
      names.forEach((name) => set.add(name));
      used.set(target, set);
    }
  }
  const unused: UnusedExport[] = [];
  for (const [path, info] of [...modules].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (isPublicEntry(path)) continue;
    const names = used.get(path) ?? new Set<string>();
    if (names.has("*")) continue;
    for (const name of info.exports) if (!names.has(name)) unused.push({ file: path, name });
  }
  return unused;
}

/** Checks every module under `packages/`, relative to the repository root. */
export async function checkRepositoryExports(root: string): Promise<UnusedExport[]> {
  return findUnusedExports(await readSources(root, "packages"));
}
