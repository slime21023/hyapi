// Measures type-checking cost for generated APIs.
// Usage: deno run -A measure.ts 50 200 500
import ts from "typescript";

const RUNS = 3;
const EDITS = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function denoCheck(n: string): Promise<number[]> {
  const times: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    await Deno.writeTextFile(`gen/n${n}/bust.ts`, `export const bust = ${Date.now()};\n`);
    const start = performance.now();
    const output = await new Deno.Command("deno", {
      args: ["check", `gen/n${n}/main.ts`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    times.push(performance.now() - start);
    if (!output.success) {
      throw new Error(`deno check failed for n=${n}:\n${new TextDecoder().decode(output.stderr)}`);
    }
  }
  return times;
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) files.push(...listFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function languageService(n: string) {
  const cwd = Deno.cwd().replaceAll("\\", "/");
  const root = `${cwd}/gen/n${n}`;
  const files = listFiles(root);
  const versions = new Map<string, number>();
  const overrides = new Map<string, string>();
  const options: ts.CompilerOptions = {
    strict: true,
    noImplicitOverride: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (file) => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file) => {
      const text = overrides.get(file) ?? ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  const edit = (file: string, change: (text: string, i: number) => string, i: number) => {
    const text = overrides.get(file) ?? Deno.readTextFileSync(file);
    overrides.set(file, change(text, i));
    versions.set(file, (versions.get(file) ?? 0) + 1);
  };
  const diagnose = (file: string) => {
    const start = performance.now();
    const count = service.getSemanticDiagnostics(file).length;
    return { ms: performance.now() - start, count };
  };

  // Cold: check every file once, as an editor opening the whole project would.
  const coldStart = performance.now();
  const program = service.getProgram()!;
  let errors = 0;
  for (const file of files) errors += service.getSemanticDiagnostics(file).length;
  const coldMs = performance.now() - coldStart;
  const checker = program.getTypeChecker();
  // deno-lint-ignore no-explicit-any
  const internal = checker as any;
  const types = internal.getTypeCount?.() ?? NaN;
  const instantiations = internal.getInstantiationCount?.() ?? NaN;
  const heapMb = Deno.memoryUsage().heapUsed / 1024 / 1024;

  const contract = `${root}/r0/contract.ts`;
  const schemas = `${root}/r0/schemas.ts`;
  const handlers = `${root}/r0/handlers.ts`;
  const scenario = (target: string, change: (t: string, i: number) => string) => {
    const times: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      edit(target, change, i);
      const { ms, count } = diagnose(handlers);
      if (count !== 0) throw new Error(`unexpected diagnostics after editing ${target}`);
      times.push(ms);
    }
    return median(times);
  };
  const contractEditMs = scenario(
    contract,
    (t, i) => t.replace(/maximum: \d+ \}\)\)/, `maximum: ${100 + i + 1} }))`),
  );
  const schemaEditMs = scenario(
    schemas,
    (t, i) => t.replace(/maxLength: \d+/, `maxLength: ${200 + i + 1}`),
  );
  const handlerEditMs = scenario(
    handlers,
    (t, i) => t.replace(/label: "child[^"]*"/, `label: "child${i}"`),
  );

  return {
    files: files.length,
    errors,
    coldMs,
    types,
    instantiations,
    heapMb,
    contractEditMs,
    schemaEditMs,
    handlerEditMs,
  };
}

const rows: string[] = [];
for (const arg of Deno.args) {
  const n = arg;
  const check = await denoCheck(n);
  const ls = languageService(n);
  const row = {
    operations: n,
    files: ls.files,
    errors: ls.errors,
    denoCheckMedianMs: Math.round(median(check)),
    denoCheckRunsMs: check.map(Math.round),
    lsColdMs: Math.round(ls.coldMs),
    types: ls.types,
    instantiations: ls.instantiations,
    heapMb: Math.round(ls.heapMb),
    editContractMs: Math.round(ls.contractEditMs),
    editSchemaMs: Math.round(ls.schemaEditMs),
    editHandlerMs: Math.round(ls.handlerEditMs),
  };
  console.log(JSON.stringify(row));
  rows.push(JSON.stringify(row));
}
await Deno.writeTextFile("results.jsonl", rows.join("\n") + "\n");
