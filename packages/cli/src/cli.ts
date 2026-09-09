export const VERSION = "1.0.0-rc.1";

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "new"; readonly directory: string }
  | { readonly kind: "generate"; readonly generator: string; readonly name: string }
  | { readonly kind: "inspect"; readonly directory: string; readonly json: boolean }
  | { readonly kind: "doctor"; readonly directory: string; readonly json: boolean };

export interface ProjectInspection {
  readonly root: string;
  readonly modules: readonly string[];
  readonly hasDenoConfig: boolean;
  readonly hasApplicationEntry: boolean;
  readonly boundaries?: ModuleBoundaryInspection;
}

export interface CrossModuleImport {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  readonly path: string;
}

export interface PortRequirement {
  readonly module: string;
  readonly port: string;
  readonly path: string;
}

export interface PortProvision {
  readonly module: string;
  readonly port: string;
  readonly path: string;
}

export interface ModuleSource {
  readonly module: string;
  readonly path: string;
  readonly text: string;
}

export interface ModuleBoundaryInspection {
  readonly analysisMode: "heuristic";
  readonly crossModuleImports: readonly CrossModuleImport[];
  readonly requiredPorts: readonly PortRequirement[];
  readonly providedPorts: readonly PortProvision[];
  readonly unresolvedReferences: readonly {
    readonly module: string;
    readonly path: string;
    readonly reference: string;
  }[];
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly suggestion?: string;
  readonly module?: string;
  readonly path?: string;
}

export interface FileSystem {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
}

const denoFileSystem: FileSystem = {
  async exists(path) {
    try {
      await Deno.stat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  },
  mkdir: (path) => Deno.mkdir(path, { recursive: true }),
  writeTextFile: (path, content) => Deno.writeTextFile(path, content),
};

export function parseCommand(args: readonly string[]): CliCommand {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return { kind: "version" };
  }
  if (command === "new" && rest[0]) return { kind: "new", directory: rest[0] };
  if (command === "generate" && rest[0] && rest[1]) {
    return { kind: "generate", generator: rest[0], name: rest[1] };
  }
  if (command === "inspect" || command === "doctor") {
    const json = rest.includes("--json");
    const directory = rest.find((value) => value !== "--json") ?? Deno.cwd();
    return { kind: command, directory, json };
  }
  throw new Error(
    `Unknown or incomplete command: ${args.join(" ") || "(empty)"}. Run 'hyapi --help'.`,
  );
}

export async function main(
  args: readonly string[],
  write: (line: string) => void = console.log,
): Promise<void> {
  const command = parseCommand(args);
  switch (command.kind) {
    case "help":
      write(helpText());
      return;
    case "version":
      write(VERSION);
      return;
    case "new":
      await createProject(command.directory, denoFileSystem);
      write(`Created HyAPI project in ${command.directory}.`);
      return;
    case "generate":
      if (command.generator !== "module") {
        throw new Error(`Unsupported generator '${command.generator}'. Supported: module.`);
      }
      await createModule(Deno.cwd(), command.name, denoFileSystem);
      write(`Created module '${command.name}'.`);
      return;
    case "inspect":
      {
        const inspection = await inspectProject(command.directory);
        write(command.json ? JSON.stringify(inspection, null, 2) : formatInspection(inspection));
      }
      return;
    case "doctor": {
      const inspection = await inspectProject(command.directory);
      const findings = doctor(inspection);
      if (command.json) write(JSON.stringify({ ...inspection, findings }, null, 2));
      else if (findings.length > 0) write(formatDiagnostics(findings));
      else {write(
          `HyAPI doctor: ${inspection.modules.length} module(s), project structure is healthy.`,
        );}
      if (findings.some((finding) => finding.severity === "error")) {
        throw new Error(`HyAPI doctor found ${findings.length} issue(s).`);
      }
      return;
    }
  }
}

export async function inspectProject(root: string): Promise<ProjectInspection> {
  const modules: string[] = [];
  const sources: ModuleSource[] = [];
  try {
    for await (const entry of Deno.readDir(`${root}/src/modules`)) {
      if (!entry.isDirectory) continue;
      modules.push(entry.name);
      sources.push(...await readModuleSources(root, entry.name));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  modules.sort();
  return {
    root,
    modules,
    hasDenoConfig: await pathExists(`${root}/deno.json`),
    hasApplicationEntry: await pathExists(`${root}/src/app.ts`),
    boundaries: inspectModuleBoundaries(sources),
  };
}

export function doctor(inspection: ProjectInspection): readonly Diagnostic[] {
  const findings: Diagnostic[] = [];
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
  for (const imported of inspection.boundaries?.crossModuleImports ?? []) {
    findings.push({
      code: "CROSS_MODULE_IMPORT",
      severity: "error",
      module: imported.from,
      path: imported.path,
      message: `Module '${imported.from}' directly imports module '${imported.to}'.`,
      suggestion: "Depend on a shared Port instead.",
    });
  }
  const provided = new Set((inspection.boundaries?.providedPorts ?? []).map((entry) => entry.port));
  for (const requirement of inspection.boundaries?.requiredPorts ?? []) {
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
  for (const unresolved of inspection.boundaries?.unresolvedReferences ?? []) {
    findings.push({
      code: "UNRESOLVED_PORT_REFERENCE",
      severity: "warning",
      module: unresolved.module,
      path: unresolved.path,
      message: `Could not resolve required Port reference '${unresolved.reference}'.`,
      suggestion: "Use a named Port declaration or string identifier.",
    });
  }
  return findings;
}

export function inspectModuleBoundaries(
  sources: readonly ModuleSource[],
): ModuleBoundaryInspection {
  const portNames = new Map<string, string>();
  for (const source of sources) {
    for (
      const match of source.text.matchAll(
        /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)[^=]*=\s*definePort(?:<[^>]*>)?\(\s*["']([^"']+)["']/g,
      )
    ) {
      const [name, port] = [match[1], match[2]];
      if (name && port) portNames.set(name, port);
    }
  }

  const crossModuleImports: CrossModuleImport[] = [];
  const requiredPorts: PortRequirement[] = [];
  const providedPorts = new Map<string, PortProvision>();
  const unresolvedReferences: { module: string; path: string; reference: string }[] = [];
  for (const source of sources) {
    for (const specifier of importedSpecifiers(source.text)) {
      const target = resolveImportedModule(source, specifier);
      if (target && target !== source.module) {
        crossModuleImports.push({ from: source.module, to: target, specifier, path: source.path });
      }
    }
    for (const match of source.text.matchAll(/requires\s*:\s*\[([\s\S]*?)\]/g)) {
      for (const reference of (match[1] ?? "").split(",")) {
        const port = resolvePortReference(reference, portNames);
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
    for (const match of source.text.matchAll(/providePort\(\s*([^,\s)]+)/g)) {
      const port = resolvePortReference(match[1] ?? "", portNames);
      if (port) providedPorts.set(port, { module: source.module, port, path: source.path });
    }
  }

  return {
    analysisMode: "heuristic",
    crossModuleImports: uniqueImports(crossModuleImports),
    requiredPorts: uniqueRequirements(requiredPorts),
    providedPorts: [...providedPorts.values()].sort((left, right) =>
      left.port.localeCompare(right.port)
    ),
    unresolvedReferences,
  };
}

async function readModuleSources(root: string, module: string): Promise<ModuleSource[]> {
  const directory = `${root}/src/modules/${module}`;
  const sources: ModuleSource[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      sources.push(...await readModuleSources(root, `${module}/${entry.name}`));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      sources.push({
        module: module.split("/")[0] ?? module,
        path,
        text: await Deno.readTextFile(path),
      });
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

function resolveImportedModule(source: ModuleSource, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const segments = source.path.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const modulesIndex = segments.lastIndexOf("modules");
  return modulesIndex === -1 ? undefined : segments[modulesIndex + 1];
}

function resolvePortReference(
  reference: string,
  portNames: ReadonlyMap<string, string>,
): string | undefined {
  const trimmed = reference.trim();
  const stringMatch = /^["']([^"']+)["']$/.exec(trimmed);
  return stringMatch?.[1] ?? portNames.get(trimmed);
}

function uniqueImports(imports: readonly CrossModuleImport[]): readonly CrossModuleImport[] {
  const seen = new Set<string>();
  return imports.filter((entry) => {
    const key = `${entry.from}\u0000${entry.to}\u0000${entry.specifier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
}

function uniqueRequirements(requirements: readonly PortRequirement[]): readonly PortRequirement[] {
  const seen = new Set<string>();
  return requirements.filter((entry) => {
    const key = `${entry.module}\u0000${entry.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) =>
    left.module.localeCompare(right.module) || left.port.localeCompare(right.port)
  );
}

function formatDiagnostics(findings: readonly Diagnostic[]): string {
  return findings.map((finding) => {
    const location = finding.path ? `\n  File: ${finding.path}` : "";
    const suggestion = finding.suggestion ? `\n  Fix: ${finding.suggestion}` : "";
    return `[${finding.severity}] ${finding.code}\n  ${finding.message}${location}${suggestion}`;
  }).join("\n");
}

function formatInspection(inspection: ProjectInspection): string {
  const mode = inspection.boundaries?.analysisMode ?? "heuristic";
  return [
    `HyAPI inspection: ${inspection.modules.length} module(s) [${mode}]`,
    `  deno.json: ${inspection.hasDenoConfig ? "found" : "missing"}`,
    `  src/app.ts: ${inspection.hasApplicationEntry ? "found" : "missing"}`,
    ...(inspection.boundaries?.crossModuleImports ?? []).map((entry) =>
      `  import: ${entry.from} -> ${entry.to} (${entry.path})`
    ),
  ].join("\n");
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

export async function createProject(directory: string, fileSystem: FileSystem): Promise<void> {
  if (await fileSystem.exists(directory)) {
    throw new Error(`Cannot create project: '${directory}' already exists.`);
  }
  await fileSystem.mkdir(directory);
  await writeFiles(fileSystem, directory, {
    "deno.json": projectConfig(),
    "src/main.ts": projectMain(),
    "src/app.ts": projectApp(),
    "src/app_test.ts": projectAppTest(),
    "src/modules/health/health.module.ts": healthModule(),
    "src/modules/users/users.module.ts": moduleTemplate("users"),
    "src/modules/users/users.routes.ts": routeTemplate("users"),
    "src/modules/users/users.schemas.ts": schemaTemplate("users"),
    "src/modules/users/users_test.ts": testTemplate("users"),
  });
}

export async function createModule(
  root: string,
  name: string,
  fileSystem: FileSystem,
): Promise<void> {
  const normalized = normalizeName(name);
  const directory = `${root}/src/modules/${normalized}`;
  if (await fileSystem.exists(directory)) {
    throw new Error(`Cannot create module: '${directory}' already exists.`);
  }
  await fileSystem.mkdir(directory);
  await writeFiles(fileSystem, directory, {
    [`${normalized}.module.ts`]: moduleTemplate(normalized),
    [`${normalized}.routes.ts`]: routeTemplate(normalized),
    [`${normalized}.schemas.ts`]: schemaTemplate(normalized),
    [`${normalized}_test.ts`]: testTemplate(normalized),
  });
}

async function writeFiles(
  fileSystem: FileSystem,
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await fileSystem.writeTextFile(`${root}/${path}`, content);
  }
}

function normalizeName(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  if (!normalized || normalized.startsWith("-") || normalized.endsWith("-")) {
    throw new Error(
      "Module names must use letters, numbers, and separators without leading/trailing separators.",
    );
  }
  return normalized;
}

function projectConfig(): string {
  return JSON.stringify(
    {
      imports: {
        "@hyapi/core": "jsr:@hyapi/core@^1.0.0-rc.1",
        "@std/assert": "jsr:@std/assert@1",
        "typebox": "npm:typebox@1",
      },
      tasks: {
        dev: "deno run --watch --allow-net src/main.ts",
        start: "deno run --allow-net src/main.ts",
        test: "deno test",
        check: "deno check src/main.ts",
        verify: "deno fmt --check && deno check src/main.ts && deno test",
      },
    },
    null,
    2,
  ) + "\n";
}

function projectMain(): string {
  return [
    'import { app } from "./app.ts";',
    "",
    "Deno.serve({ port: 8000 }, app.fetch);",
  ].join("\n") + "\n";
}

function projectApp(): string {
  return [
    'import { createApplication } from "@hyapi/core";',
    'import { healthModule } from "./modules/health/health.module.ts";',
    'import { usersModule } from "./modules/users/users.module.ts";',
    "",
    "export const app = await createApplication({",
    '  config: { name: "hyapi-app", version: "0.1.0", environment: "development", requestIdHeader: "x-request-id", openapi: { title: "HyAPI App", version: "0.1.0", path: "/openapi.json" } },',
    "  modules: [healthModule, usersModule],",
    "});",
  ].join("\n") + "\n";
}

function projectAppTest(): string {
  return [
    'import { assertEquals } from "@std/assert";',
    'import { app } from "./app.ts";',
    "",
    'Deno.test("starter application exposes health and OpenAPI", async () => {',
    '  assertEquals((await app.request("http://test/health")).status, 200);',
    '  assertEquals((await app.request("http://test/openapi.json")).status, 200);',
    "});",
  ].join("\n") + "\n";
}

function healthModule(): string {
  return [
    'import { defineModule, defineRoute } from "@hyapi/core";',
    "",
    "export const healthModule = defineModule({",
    '  name: "health",',
    "  setup(module) {",
    '    module.route(defineRoute({ method: "get", path: "/health", handler: ({ ok }) => ok({ status: "ok" }) }));',
    "  },",
    "});",
  ].join("\n") + "\n";
}

function moduleTemplate(name: string): string {
  return [
    'import { defineModule } from "@hyapi/core";',
    `import { register${pascalCase(name)}Routes } from "./${name}.routes.ts";`,
    "",
    `export const ${camelCase(name)}Module = defineModule({`,
    `  name: "${name}",`,
    "  setup(module) {",
    "    register" + pascalCase(name) + "Routes(module);",
    "  },",
    "});",
  ].join("\n") + "\n";
}

function routeTemplate(name: string): string {
  return [
    'import { defineRoute, type ModuleApi } from "@hyapi/core";',
    "",
    `export function register${pascalCase(name)}Routes(module: ModuleApi): void {`,
    "  module.route(defineRoute({",
    '    method: "get",',
    `    path: "/${name}",`,
    `    handler: ({ ok }) => ok({ module: "${name}" }),`,
    "  }));",
    "}",
  ].join("\n") + "\n";
}

function schemaTemplate(name: string): string {
  return [
    'import Type from "typebox";',
    "",
    `export const ${pascalCase(name)}ResponseSchema = Type.Object({`,
    "  module: Type.String(),",
    "});",
  ].join("\n") + "\n";
}

function testTemplate(name: string): string {
  return [
    'import { assertEquals } from "@std/assert";',
    `import { ${camelCase(name)}Module } from "./${name}.module.ts";`,
    "",
    `Deno.test("${name} module is defined", () => {`,
    `  assertEquals(${camelCase(name)}Module.name, "${name}");`,
    "});",
  ].join("\n") + "\n";
}

function pascalCase(value: string): string {
  return value.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
}

function camelCase(value: string): string {
  const pascal = pascalCase(value);
  return pascal[0]?.toLowerCase() + pascal.slice(1);
}

function helpText(): string {
  return [
    "HyAPI CLI",
    "",
    "Usage:",
    "  hyapi --help",
    "  hyapi --version",
    "  hyapi new <directory>",
    "  hyapi generate module <name>",
    "  hyapi inspect [directory]",
    "  hyapi inspect [directory] --json",
    "  hyapi doctor [directory] [--json]",
    "",
    "Run with Deno:",
    "  deno run --allow-read --allow-write jsr:@hyapi/cli --help",
  ].join("\n");
}
