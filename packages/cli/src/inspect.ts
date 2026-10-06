type Source = {
  readonly module: string;
  readonly path: string;
  readonly text: string;
};

type Boundary = {
  readonly crossModuleImports: readonly {
    readonly from: string;
    readonly to: string;
    readonly specifier: string;
    readonly path: string;
  }[];
  readonly requiredPorts: readonly {
    readonly module: string;
    readonly port: string;
    readonly path: string;
  }[];
  readonly providedPorts: readonly {
    readonly module: string;
    readonly port: string;
    readonly path: string;
  }[];
  readonly unresolvedReferences: readonly {
    readonly module: string;
    readonly path: string;
    readonly reference: string;
  }[];
};

type Inspection = {
  readonly root: string;
  readonly modules: readonly string[];
  readonly hasDenoConfig: boolean;
  readonly hasApplicationEntry: boolean;
  readonly boundaries: Boundary;
};

type Finding = {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly suggestion?: string;
  readonly module?: string;
  readonly path?: string;
};

export async function inspectProject(root: string): Promise<Inspection> {
  const modules: string[] = [];
  const sources: Source[] = [];
  try {
    for await (const entry of Deno.readDir(`${root}/src/modules`)) {
      if (!entry.isDirectory) continue;
      modules.push(entry.name);
      sources.push(...await readSources(`${root}/src/modules/${entry.name}`, entry.name));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  modules.sort();

  const sharedSources: Source[] = [];
  try {
    sharedSources.push(...await readSources(`${root}/src/contracts`, "contracts"));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const applicationPath = `${root}/src/app.ts`;
  const hasApplicationEntry = await pathExists(applicationPath);
  if (hasApplicationEntry) {
    sharedSources.push({
      module: "app",
      path: applicationPath,
      text: await Deno.readTextFile(applicationPath),
    });
  }
  return {
    root,
    modules,
    hasDenoConfig: await pathExists(`${root}/deno.json`),
    hasApplicationEntry,
    boundaries: scanBoundaries(sources, sharedSources),
  };
}

export function diagnose(inspection: Inspection): readonly Finding[] {
  const findings: Finding[] = [];
  if (!inspection.hasDenoConfig) {
    findings.push({
      code: "PROJECT_CONFIG_MISSING",
      severity: "error",
      message: "Missing deno.json.",
      suggestion: "Run 'hyapi new <directory>'.",
    });
  }
  if (!inspection.hasApplicationEntry) {
    findings.push({
      code: "APPLICATION_ENTRY_MISSING",
      severity: "error",
      message: "Missing src/app.ts application entrypoint.",
    });
  }
  if (inspection.modules.length === 0) {
    findings.push({
      code: "MODULES_MISSING",
      severity: "error",
      message: "No modules found under src/modules.",
    });
  }
  for (const imported of inspection.boundaries.crossModuleImports) {
    findings.push({
      code: "CROSS_MODULE_IMPORT",
      severity: "error",
      module: imported.from,
      path: imported.path,
      message: `Module '${imported.from}' directly imports module '${imported.to}'.`,
      suggestion: "Depend on a shared Port instead.",
    });
  }
  const provided = new Set(inspection.boundaries.providedPorts.map((entry) => entry.port));
  for (const requirement of inspection.boundaries.requiredPorts) {
    if (!provided.has(requirement.port)) {
      findings.push({
        code: "PORT_PROVIDER_MISSING",
        severity: "error",
        module: requirement.module,
        path: requirement.path,
        message:
          `Module '${requirement.module}' requires port '${requirement.port}', but no provider was found.`,
        suggestion: "Register a local or HTTP provider for this Port.",
      });
    }
  }
  for (const unresolved of inspection.boundaries.unresolvedReferences) {
    findings.push({
      code: "UNRESOLVED_PORT_REFERENCE",
      severity: "warning",
      module: unresolved.module,
      path: unresolved.path,
      message: `Could not resolve required Port reference '${unresolved.reference}'.`,
      suggestion:
        "Declare the Port with definePort() in src/contracts/ or the module, and reference it by name.",
    });
  }
  return findings;
}

export function formatInspection(inspection: Inspection): string {
  return [
    `HyAPI inspection: ${inspection.modules.length} module(s) [heuristic]`,
    `  deno.json: ${inspection.hasDenoConfig ? "found" : "missing"}`,
    `  src/app.ts: ${inspection.hasApplicationEntry ? "found" : "missing"}`,
    ...inspection.boundaries.crossModuleImports.map((entry) =>
      `  import: ${entry.from} -> ${entry.to} (${entry.path})`
    ),
    ...inspection.boundaries.requiredPorts.map((entry) =>
      `  requires: ${entry.module} -> ${entry.port}`
    ),
    ...inspection.boundaries.providedPorts.map((entry) =>
      `  provides: ${entry.port} (${entry.path})`
    ),
  ].join("\n");
}

export function formatDiagnostics(findings: readonly Finding[]): string {
  return findings.map((finding) => {
    const location = finding.path ? `\n  File: ${finding.path}` : "";
    const suggestion = finding.suggestion ? `\n  Fix: ${finding.suggestion}` : "";
    return `[${finding.severity}] ${finding.code}\n  ${finding.message}${location}${suggestion}`;
  }).join("\n");
}

function scanBoundaries(sources: readonly Source[], sharedSources: readonly Source[]): Boundary {
  // ponytail: heuristic text scan; introduce an AST only if supported source syntax outgrows these checks.
  const moduleSources = sources.map((source) => ({ ...source, text: stripComments(source.text) }));
  const allSources = [
    ...moduleSources,
    ...sharedSources.map((source) => ({ ...source, text: stripComments(source.text) })),
  ];
  const portNames = new Map<string, string | undefined>();
  const modulePortNames = new Map<string, Map<string, string | undefined>>();
  const sourcePortNames = new Map<Source, Map<string, string>>();
  for (const source of allSources) {
    const local = new Map<string, string>();
    sourcePortNames.set(source, local);
    const moduleNames = modulePortNames.get(source.module) ?? new Map<string, string | undefined>();
    modulePortNames.set(source.module, moduleNames);
    for (
      const match of source.text.matchAll(
        /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)[^=]*=\s*definePort(?:<[^>]*>)?\(\s*["']([^"']+)["']/g,
      )
    ) {
      const [name, port] = [match[1], match[2]];
      if (name && port) {
        local.set(name, port);
        rememberPortName(moduleNames, name, port);
        rememberPortName(portNames, name, port);
      }
    }
  }

  const sourcesByPath = new Map(
    allSources.map((source) => [source.path.replaceAll("\\", "/"), source]),
  );
  const importedPortNames = new Map<Source, Map<string, string | undefined>>();
  for (const source of allSources) {
    const imports = new Map<string, string | undefined>();
    importedPortNames.set(source, imports);
    for (
      const match of source.text.matchAll(
        /\bimport\s+(?:type\s+)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g,
      )
    ) {
      const target = sourcesByPath.get(resolveImportedPath(source, match[2] ?? "") ?? "");
      for (const entry of (match[1] ?? "").split(",")) {
        const binding = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/
          .exec(entry.trim());
        if (binding?.[1]) {
          imports.set(
            binding[2] ?? binding[1],
            target ? sourcePortNames.get(target)?.get(binding[1]) : undefined,
          );
        }
      }
    }
  }

  const crossModuleImports: Array<Boundary["crossModuleImports"][number]> = [];
  const requiredPorts: Array<Boundary["requiredPorts"][number]> = [];
  const providedPorts = new Map<string, Boundary["providedPorts"][number]>();
  const unresolvedReferences: Array<Boundary["unresolvedReferences"][number]> = [];
  for (const source of moduleSources) {
    for (const specifier of importedSpecifiers(source.text)) {
      const target = resolveImportedModule(source, specifier);
      if (target && target !== source.module) {
        crossModuleImports.push({ from: source.module, to: target, specifier, path: source.path });
      }
    }
    for (const match of source.text.matchAll(/requires\s*:\s*\[([\s\S]*?)\]/g)) {
      for (const reference of (match[1] ?? "").split(",")) {
        const port = resolvePortReference(
          reference,
          sourcePortNames.get(source)!,
          importedPortNames.get(source)!,
          modulePortNames.get(source.module)!,
          portNames,
        );
        if (port) requiredPorts.push({ module: source.module, port, path: source.path });
        else if (reference.trim()) {
          unresolvedReferences.push({
            module: source.module,
            path: source.path,
            reference: reference.trim(),
          });
        }
      }
    }
  }
  for (const source of moduleSources) {
    for (const match of source.text.matchAll(/provides\s*:\s*\[([\s\S]*?)\]/g)) {
      for (const reference of (match[1] ?? "").split(",")) {
        const port = resolvePortReference(
          reference,
          sourcePortNames.get(source)!,
          importedPortNames.get(source)!,
          modulePortNames.get(source.module)!,
          portNames,
        );
        if (port) providedPorts.set(port, { module: source.module, port, path: source.path });
      }
    }
  }
  for (const source of allSources) {
    for (const match of source.text.matchAll(/provide(?:Port|Http)\(\s*([^,\s)]+)/g)) {
      const port = resolvePortReference(
        match[1] ?? "",
        sourcePortNames.get(source)!,
        importedPortNames.get(source)!,
        modulePortNames.get(source.module)!,
        portNames,
      );
      if (port) providedPorts.set(port, { module: source.module, port, path: source.path });
    }
  }

  return {
    crossModuleImports: unique(
      crossModuleImports,
      (entry) => `${entry.from}\u0000${entry.to}\u0000${entry.specifier}`,
    )
      .sort((left, right) =>
        left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
      ),
    requiredPorts: unique(requiredPorts, (entry) => `${entry.module}\u0000${entry.port}`)
      .sort((left, right) =>
        left.module.localeCompare(right.module) || left.port.localeCompare(right.port)
      ),
    providedPorts: [...providedPorts.values()].sort((left, right) =>
      left.port.localeCompare(right.port)
    ),
    unresolvedReferences,
  };
}

function unique<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const entryKey = key(entry);
    if (seen.has(entryKey)) return false;
    seen.add(entryKey);
    return true;
  });
}

function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

async function readSources(directory: string, module: string): Promise<Source[]> {
  const sources: Source[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) sources.push(...await readSources(path, module));
    else if (entry.isFile && entry.name.endsWith(".ts")) {
      sources.push({ module, path, text: await Deno.readTextFile(path) });
    }
  }
  return sources;
}

function importedSpecifiers(source: string): readonly string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    if (match[1]) specifiers.add(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    if (match[1]) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function resolveImportedModule(source: Source, specifier: string): string | undefined {
  const path = resolveImportedPath(source, specifier);
  if (!path) return undefined;
  const segments = path.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    if (segments[index] === "modules" && segments[index - 1] === "src") return segments[index + 1];
  }
  return undefined;
}

function resolveImportedPath(source: Source, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const segments = source.path.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function resolvePortReference(
  reference: string,
  local: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, string | undefined>,
  moduleNames: ReadonlyMap<string, string | undefined>,
  globalNames: ReadonlyMap<string, string | undefined>,
): string | undefined {
  const trimmed = reference.trim();
  const stringMatch = /^["']([^"']+)["']$/.exec(trimmed);
  if (stringMatch) return stringMatch[1];
  if (local.has(trimmed)) return local.get(trimmed);
  if (imports.has(trimmed)) return imports.get(trimmed);
  if (moduleNames.has(trimmed)) return moduleNames.get(trimmed);
  return globalNames.get(trimmed);
}

function rememberPortName(
  names: Map<string, string | undefined>,
  name: string,
  port: string,
): void {
  if (!names.has(name)) names.set(name, port);
  else if (names.get(name) !== port) names.set(name, undefined);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
