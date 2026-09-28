import { diagnose, formatDiagnostics, formatInspection, inspectProject } from "./inspect.ts";
import { createModule, createProject } from "./project.ts";

const VERSION = "1.0.0-rc.3";

type Command =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "new"; readonly directory: string }
  | { readonly kind: "generate"; readonly generator: string; readonly name: string }
  | { readonly kind: "inspect"; readonly directory?: string; readonly json: boolean }
  | { readonly kind: "doctor"; readonly directory?: string; readonly json: boolean };

/** Runs the CLI. Tests import this private source entry rather than the package facade. */
export async function run(
  args: readonly string[],
  write: (line: string) => void = console.log,
  cwd = Deno.cwd(),
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
      await createProject(command.directory, VERSION);
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
        const name = await createModule(cwd, command.name);
        const moduleName = camelCase(name);
        write(`Created module '${name}'.`);
        write(
          `Register it in src/app.ts: import { ${moduleName}Module } from "./modules/${name}/module.ts";`,
        );
        write(`Then add ${moduleName}Module to createApplication({ modules }).`);
      }
      return;
    case "inspect": {
      const inspection = await inspectProject(command.directory ?? cwd);
      write(command.json ? JSON.stringify(inspection, null, 2) : formatInspection(inspection));
      return;
    }
    case "doctor": {
      const inspection = await inspectProject(command.directory ?? cwd);
      const findings = diagnose(inspection);
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

function parseCommand(args: readonly string[]): Command {
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
    if (jsonArgs.length <= 1 && directories.length <= 1 && !directories[0]?.startsWith("-")) {
      return directories[0] === undefined
        ? { kind: command, json: jsonArgs.length === 1 }
        : { kind: command, directory: directories[0], json: jsonArgs.length === 1 };
    }
  }
  throw new Error(
    `Unknown or incomplete command: ${args.join(" ") || "(empty)"}. Run 'hyapi --help'.`,
  );
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
    "  hyapi inspect [directory] [--json]",
    "  hyapi doctor [directory] [--json]",
    "",
    "Run with Deno:",
    "  deno run --allow-read --allow-write jsr:@hyapi/cli --help",
  ].join("\n");
}
