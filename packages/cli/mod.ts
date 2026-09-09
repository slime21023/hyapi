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
  ModuleBoundaryInspection,
  ModuleSource,
  PortProvision,
  PortRequirement,
  ProjectInspection,
} from "./src/cli.ts";

if (import.meta.main) {
  await main(Deno.args);
}
