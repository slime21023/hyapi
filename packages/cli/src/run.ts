import { resolve } from "jsr:@std/path@^1";
import { UsageError } from "./config.ts";
import { diffCommand } from "./diff.ts";
import { doctorCommand } from "./doctor.ts";
import { emitCommand } from "./emit.ts";
import { newCommand } from "./new.ts";

/** Output channels, so commands can be tested without a terminal. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Options for {@link run}. */
export interface RunOptions {
  /** The project directory. Defaults to the current directory. */
  readonly cwd?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

const USAGE = [
  "Usage: hyapi <command> [options]",
  "",
  "Commands:",
  "  new <dir> [--local <repository>]  Create a project; --local links an unpublished checkout.",
  "  emit [--check]                    Write the OpenAPI document, or verify that it is current.",
  "  doctor                            Check the contracts and the committed document.",
  "  diff [--format text|markdown|json] [--allow-breaking]",
  "                                    Compare the contracts with the document on main.",
  "",
  "Options for emit and doctor:",
  '  --api <module#export>  The defineApi module (default: deno.json "hyapi.api").',
  '  --out <file>           The OpenAPI document, .json/.yaml/.yml (default: "hyapi.openapi").',
  "",
  "Exit codes: 0 success, 1 problems found, 2 usage error.",
].join("\n");

const BOOLEAN_FLAGS = new Set(["check", "help", "allow-breaking"]);

function parse(args: readonly string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else if (separator !== -1) flags[name] = arg.slice(separator + 1);
    else if (i + 1 < args.length) flags[name] = args[++i]!;
    else throw new UsageError(`--${name} needs a value`);
  }
  return { positional, flags };
}

function allowOnly(flags: Record<string, string | true>, allowed: readonly string[]): void {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) throw new UsageError(`unknown option --${name}`);
  }
}

function value(flag: string | true | undefined): string | undefined {
  return typeof flag === "string" ? flag : undefined;
}

/** Runs one CLI command and returns its exit code. */
export async function run(args: readonly string[], options: RunOptions = {}): Promise<number> {
  const io: Io = {
    out: options.stdout ?? ((line) => console.log(line)),
    err: options.stderr ?? ((line) => console.error(line)),
  };
  const cwd = resolve(options.cwd ?? Deno.cwd());
  try {
    const { positional, flags } = parse(args);
    const [command, ...rest] = positional;
    if (command === undefined || command === "help" || flags.help === true) {
      io.out(USAGE);
      return command === undefined && flags.help !== true ? 2 : 0;
    }
    const api = value(flags.api);
    const out = value(flags.out);
    const project = {
      ...(api === undefined ? {} : { api }),
      ...(out === undefined ? {} : { out }),
    };
    switch (command) {
      case "emit":
        allowOnly(flags, ["api", "out", "check"]);
        return await emitCommand(cwd, { ...project, check: flags.check === true }, io);
      case "diff": {
        allowOnly(flags, ["api", "out", "format", "allow-breaking"]);
        const format = value(flags.format) ?? "text";
        if (format !== "text" && format !== "markdown" && format !== "json") {
          throw new UsageError("--format must be text, markdown, or json");
        }
        return await diffCommand(
          cwd,
          { ...project, format, allowBreaking: flags["allow-breaking"] === true },
          io,
        );
      }
      case "doctor":
        allowOnly(flags, ["api", "out"]);
        return await doctorCommand(cwd, project, io);
      case "new":
        allowOnly(flags, ["local"]);
        if (rest.length !== 1) throw new UsageError("new needs exactly one directory");
        return await newCommand(resolve(cwd, rest[0]!), value(flags.local), io);
      default:
        throw new UsageError(`unknown command '${command}'`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`hyapi: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
