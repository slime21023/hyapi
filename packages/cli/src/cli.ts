export const VERSION = "1.0.0-rc.3";

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
  if (command === undefined) return { kind: "help" };
  if (command === "help" || command === "--help" || command === "-h") {
    if (rest.length === 0) return { kind: "help" };
  } else if (command === "--version" || command === "-v" || command === "version") {
    if (rest.length === 0) return { kind: "version" };
  } else if (command === "new") {
    if (rest.length === 1 && rest[0] && !rest[0].startsWith("-")) {
      return { kind: "new", directory: rest[0] };
    }
  } else if (command === "generate") {
    if (
      rest.length === 2 && rest[0] && !rest[0].startsWith("-") &&
      rest[1] && !rest[1].startsWith("-")
    ) {
      return { kind: "generate", generator: rest[0], name: rest[1] };
    }
  } else if (command === "inspect" || command === "doctor") {
    const jsonArgs = rest.filter((value) => value === "--json");
    const directories = rest.filter((value) => value !== "--json");
    if (
      jsonArgs.length <= 1 && directories.length <= 1 &&
      !directories[0]?.startsWith("-")
    ) {
      return {
        kind: command,
        directory: directories[0] ?? Deno.cwd(),
        json: jsonArgs.length === 1,
      };
    }
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
      write(
        `The starter requires jsr:@hyapi/core@^${VERSION}; publication was not checked. ` +
          "Run 'deno task check' in the project before starting it.",
      );
      return;
    case "generate":
      if (command.generator !== "module") {
        throw new Error(`Unsupported generator '${command.generator}'. Supported: module.`);
      }
      {
        const name = await createModule(Deno.cwd(), command.name, denoFileSystem);
        const camel = camelCase(name);
        write(`Created module '${name}'.`);
        write(
          `Register it in src/app.ts: import { ${camel}Module } from "./modules/${name}/${name}.module.ts";`,
        );
        write(`Then add ${camel}Module to createApplication({ modules }).`);
      }
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
      sources.push(...await readSources(`${root}/src/modules/${entry.name}`, entry.name));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  modules.sort();
  const sharedSources: ModuleSource[] = [];
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
    boundaries: inspectModuleBoundaries(sources, sharedSources),
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
      suggestion:
        "Declare the Port with definePort() in src/contracts/ or the module, and reference it by name.",
    });
  }
  return findings;
}

export function inspectModuleBoundaries(
  sources: readonly ModuleSource[],
  sharedSources: readonly ModuleSource[] = [],
): ModuleBoundaryInspection {
  const moduleSources = sources.map((source) => ({ ...source, text: stripComments(source.text) }));
  const allSources = [
    ...moduleSources,
    ...sharedSources.map((source) => ({ ...source, text: stripComments(source.text) })),
  ];
  const portNames = new Map<string, string | undefined>();
  const modulePortNames = new Map<string, Map<string, string | undefined>>();
  const sourcePortNames = new Map<ModuleSource, Map<string, string>>();
  for (const source of allSources) {
    const local = new Map<string, string>();
    sourcePortNames.set(source, local);
    let moduleNames = modulePortNames.get(source.module);
    if (!moduleNames) {
      moduleNames = new Map();
      modulePortNames.set(source.module, moduleNames);
    }
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
  const importedPortNames = new Map<ModuleSource, Map<string, string | undefined>>();
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

  const crossModuleImports: CrossModuleImport[] = [];
  const requiredPorts: PortRequirement[] = [];
  const providedPorts = new Map<string, PortProvision>();
  const unresolvedReferences: { module: string; path: string; reference: string }[] = [];
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
    analysisMode: "heuristic",
    crossModuleImports: uniqueImports(crossModuleImports),
    requiredPorts: uniqueRequirements(requiredPorts),
    providedPorts: [...providedPorts.values()].sort((left, right) =>
      left.port.localeCompare(right.port)
    ),
    unresolvedReferences,
  };
}

function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

async function readSources(directory: string, module: string): Promise<ModuleSource[]> {
  const sources: ModuleSource[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      sources.push(...await readSources(path, module));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
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

function resolveImportedModule(source: ModuleSource, specifier: string): string | undefined {
  const path = resolveImportedPath(source, specifier);
  if (!path) return undefined;
  const segments = path.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    if (segments[index] === "modules" && segments[index - 1] === "src") {
      return segments[index + 1];
    }
  }
  return undefined;
}

function resolveImportedPath(source: ModuleSource, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const segments = source.path.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function rememberPortName(
  names: Map<string, string | undefined>,
  name: string,
  port: string,
): void {
  if (!names.has(name)) names.set(name, port);
  else if (names.get(name) !== port) names.set(name, undefined);
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
    ...(inspection.boundaries?.requiredPorts ?? []).map((entry) =>
      `  requires: ${entry.module} -> ${entry.port}`
    ),
    ...(inspection.boundaries?.providedPorts ?? []).map((entry) =>
      `  provides: ${entry.port} (${entry.path})`
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
): Promise<string> {
  const normalized = normalizeName(name);
  if (
    !(await fileSystem.exists(`${root}/deno.json`)) ||
    !(await fileSystem.exists(`${root}/src/app.ts`))
  ) {
    throw new Error(
      `Cannot generate module outside a HyAPI project root: '${root}' needs deno.json and src/app.ts. ` +
        "Run 'cd my-api' (or your project directory) and retry.",
    );
  }
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
  return normalized;
}

async function writeFiles(
  fileSystem: FileSystem,
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (path.includes("/")) {
      await fileSystem.mkdir(`${root}/${path.slice(0, path.lastIndexOf("/"))}`);
    }
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
  if (!/^[a-z]/.test(normalized)) throw new Error("Module names must start with a letter.");
  return normalized;
}

function projectConfig(): string {
  return JSON.stringify(
    {
      imports: {
        "@hyapi/core": `jsr:@hyapi/core@^${VERSION}`,
        "@std/assert": "jsr:@std/assert@1",
        "typebox": "npm:typebox@1",
      },
      tasks: {
        dev: "deno run --watch --allow-net --allow-env --unstable-no-legacy-abort src/main.ts",
        start: "deno run --allow-net --allow-env --unstable-no-legacy-abort src/main.ts",
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
  return `import { app } from "./app.ts";

const host = Deno.env.get("HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("PORT") ?? "8000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

const controller = new AbortController();
const transmissions = new Set<Promise<void>>();
let notifyIdle: (() => void) | undefined;
const server = Deno.serve(
  { hostname: host, port, signal: controller.signal },
  (request, info) => {
    const completed = info.completed;
    transmissions.add(completed);
    const settled = () => {
      transmissions.delete(completed);
      if (transmissions.size === 0) notifyIdle?.();
    };
    void completed.then(settled, settled);
    return app.fetch(request);
  },
);

let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  return stopping ??= (async () => {
    const closingApp = app.close();
    const deadline = Date.now() + 2 * (app.config.shutdownTimeoutMs ?? 30_000) +
      1_000;
    const watchdog = new AbortController();
    const closingServer = (async () => {
      if (transmissions.size > 0) {
        const idle = new Promise<void>((resolve) => {
          notifyIdle = resolve;
          if (transmissions.size === 0) resolve();
        });
        await Promise.race([idle, abortAfter(deadline, watchdog.signal)]);
      }
      if (transmissions.size > 0) controller.abort();
      await server.shutdown();
      await server.finished;
    })();
    try {
      const results = await Promise.allSettled([closingApp, closingServer]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : []
      );
      if (errors.length > 1) {
        throw new AggregateError(errors, "Server shutdown failed.");
      }
      if (errors.length === 1) throw errors[0];
    } finally {
      watchdog.abort();
    }
  })();
}

async function abortAfter(
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, Math.min(remaining, 2_147_483_647));
      function finish() {
        signal.removeEventListener("abort", finish);
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    void stop().catch(console.error);
  });
}
try {
  await server.finished;
} finally {
  await stop();
}
`;
}

function projectApp(): string {
  return [
    'import { createApplication, defineConfig } from "@hyapi/core";',
    'import { healthModule } from "./modules/health/health.module.ts";',
    'import { usersModule } from "./modules/users/users.module.ts";',
    "",
    "export const app = await createApplication({",
    '  config: defineConfig({ name: "hyapi-app" }),',
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
    '  assertEquals((await app.request("http://test/health/live")).status, 200);',
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
    "    module.route(",
    "      defineRoute({",
    '        method: "get",',
    '        path: "/health/live",',
    '        handler: ({ ok }) => ok({ status: "ok" }),',
    "      }),",
    "    );",
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
    `import { ${pascalCase(name)}ResponseSchema } from "./${name}.schemas.ts";`,
    "",
    `export function register${pascalCase(name)}Routes(module: ModuleApi): void {`,
    "  module.route(defineRoute({",
    '    method: "get",',
    `    path: "/${name}",`,
    `    responses: { 200: ${pascalCase(name)}ResponseSchema },`,
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
    'import { createApplication, defineConfig } from "@hyapi/core";',
    `import { ${camelCase(name)}Module } from "./${name}.module.ts";`,
    "",
    `Deno.test("${name} responds on /${name}", async () => {`,
    "  const app = await createApplication({",
    `    config: defineConfig({ name: "${name}-test" }),`,
    `    modules: [${camelCase(name)}Module],`,
    "  });",
    "  try {",
    `    const response = await app.request("http://test/${name}");`,
    "    assertEquals(response.status, 200);",
    `    assertEquals(await response.json(), { module: "${name}" });`,
    "  } finally {",
    "    await app.close();",
    "  }",
    "});",
  ].join("\n") + "\n";
}

function pascalCase(value: string): string {
  return value.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
}

function camelCase(value: string): string {
  return value.split("-").map((part, index) => {
    if (index === 0) return part;
    return /^[0-9]/.test(part) ? `_${part}` : part[0]?.toUpperCase() + part.slice(1);
  }).join("");
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
