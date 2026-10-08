// Enforces the dependency rules of ADR 0002 §3 by scanning import specifiers in packages/.

export type Component =
  | "contract"
  | "runtime"
  | "openapi"
  | "serve"
  | "cli"
  | "openapi-diff"
  | "plugin";

export interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

interface Target {
  readonly component?: Component;
  /** The package that owns the target, for same-package checks between plugins. */
  readonly owner?: string;
  /** The target is one of the four public `@hyapi/core` entry points, or another package entry. */
  readonly publicEntry: boolean;
  /** The bare package name for anything outside the repository. */
  readonly external?: string;
}

interface Rule {
  /** Components that may be imported through internal (relative) paths. */
  readonly internal: readonly Component[];
  /** Components that may be imported only through their public entry points. */
  readonly public: readonly Component[];
  /** Allowed external packages, or `"any"`. */
  readonly external: readonly string[] | "any";
}

const RULES: Record<Component, Rule> = {
  contract: { internal: ["contract"], public: [], external: ["typebox"] },
  openapi: { internal: ["openapi", "contract"], public: [], external: [] },
  runtime: { internal: ["runtime", "contract"], public: [], external: ["typebox"] },
  serve: { internal: ["serve"], public: ["runtime"], external: [] },
  "openapi-diff": { internal: ["openapi-diff"], public: [], external: [] },
  cli: { internal: ["cli"], public: ["contract", "openapi", "openapi-diff"], external: "any" },
  plugin: { internal: ["plugin"], public: ["runtime", "contract"], external: "any" },
};

const CORE_ENTRIES: Record<string, Component> = {
  "packages/core/contract.ts": "contract",
  "packages/core/openapi.ts": "openapi",
  "packages/core/mod.ts": "runtime",
  "packages/core/deno.ts": "serve",
};

const PACKAGE_ENTRIES: Record<string, Component> = {
  "@hyapi/core": "runtime",
  "@hyapi/core/contract": "contract",
  "@hyapi/core/openapi": "openapi",
  "@hyapi/core/deno": "serve",
  "@hyapi/openapi-diff": "openapi-diff",
  "@hyapi/cli": "cli",
};

/** Classifies a repository-relative path, or returns undefined when it belongs to no component. */
export function componentOf(path: string): { component: Component; owner: string } | undefined {
  const entry = CORE_ENTRIES[path];
  if (entry) return { component: entry, owner: "core" };
  const core = path.match(/^packages\/core\/src\/(contract|runtime|openapi|deno)\//);
  if (core) {
    const name = core[1] === "deno" ? "serve" : core[1] as Component;
    return { component: name, owner: "core" };
  }
  if (path.startsWith("packages/cli/")) return { component: "cli", owner: "cli" };
  if (path.startsWith("packages/openapi-diff/")) {
    return { component: "openapi-diff", owner: "openapi-diff" };
  }
  const plugin = path.match(/^packages\/(plugin-[^/]+)\//);
  if (plugin) return { component: "plugin", owner: plugin[1]! };
  return undefined;
}

/** Extracts static, re-export, type-only, side-effect, and dynamic import specifiers. */
export function importSpecifiers(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const specifiers: string[] = [];
  const statement = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of code.matchAll(statement)) specifiers.push(match[1]!);
  for (const match of code.matchAll(dynamic)) specifiers.push(match[1]!);
  return specifiers;
}

function resolveRelative(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/** `npm:@scope/name@1/sub` → `@scope/name`; `typebox/value` → `typebox`. */
function packageName(specifier: string): string {
  const [first = "", second = ""] = specifier.replace(/^(npm|jsr):\/?/, "").split("/");
  const withoutVersion = (name: string) => name.split("@")[0]!;
  return first.startsWith("@") ? `${first}/${withoutVersion(second)}` : withoutVersion(first);
}

function targetOf(from: string, specifier: string): Target {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const path = resolveRelative(from, specifier);
    const owner = componentOf(path);
    return {
      ...(owner ? { component: owner.component, owner: owner.owner } : {}),
      publicEntry: path in CORE_ENTRIES || /^packages\/[^/]+\/mod\.ts$/.test(path),
    };
  }
  const entry = PACKAGE_ENTRIES[specifier];
  if (entry) return { component: entry, owner: specifier, publicEntry: true };
  const plugin = specifier.match(/^@hyapi\/(plugin-[^/]+)$/);
  if (plugin) return { component: "plugin", owner: plugin[1]!, publicEntry: true };
  if (specifier.startsWith("@hyapi/")) {
    return { component: "runtime", owner: specifier, publicEntry: false };
  }
  return { publicEntry: false, external: packageName(specifier) };
}

/** Checks one source file against the rules of its component. */
export function checkFile(path: string, source: string): Violation[] {
  const self = componentOf(path);
  if (!self) return [];
  const rule = RULES[self.component];
  const violations: Violation[] = [];
  for (const specifier of importSpecifiers(source)) {
    const target = targetOf(path, specifier);
    const fail = (reason: string) => violations.push({ file: path, specifier, reason });
    if (target.external !== undefined) {
      if (rule.external !== "any" && !rule.external.includes(target.external)) {
        fail(`${self.component} may not depend on external package "${target.external}"`);
      }
      continue;
    }
    if (!target.component) {
      fail(`${self.component} imports a file outside any component`);
      continue;
    }
    if (target.component === self.component && target.owner === self.owner) continue;
    if (target.component === "plugin" && self.component === "plugin") {
      fail("plugins may not depend on other plugins");
      continue;
    }
    const sameCore = self.owner === "core" && target.owner === "core";
    if (sameCore && !target.publicEntry && rule.internal.includes(target.component)) continue;
    if (
      target.publicEntry && (rule.public.includes(target.component) ||
        (sameCore && rule.internal.includes(target.component)))
    ) continue;
    fail(
      rule.public.includes(target.component)
        ? `${self.component} must import ${target.component} through its public entry point`
        : `${self.component} may not depend on ${target.component}`,
    );
  }
  return violations;
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) yield path;
  }
}

/** Checks every TypeScript file under `packages/`, relative to the repository root. */
export async function checkRepository(root: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  for await (const file of sourceFiles(`${root}/packages`)) {
    const path = file.slice(root.length + 1);
    if (!componentOf(path)) {
      violations.push({ file: path, specifier: "", reason: "file belongs to no component" });
      continue;
    }
    violations.push(...checkFile(path, await Deno.readTextFile(file)));
  }
  return violations;
}
