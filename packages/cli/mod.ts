import { main } from "./src/cli.ts";

export {
  createModule,
  createProject,
  doctor,
  inspectModuleBoundaries,
  inspectProject,
  main,
  parseCommand,
  VERSION,
} from "./src/cli.ts";
export type {
  CrossModuleImport,
  Diagnostic,
  FileSystem,
  ModuleBoundaryInspection,
  ModuleSource,
  PortProvision,
  PortRequirement,
  ProjectInspection,
} from "./src/cli.ts";

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    Deno.exit(1);
  }
}
