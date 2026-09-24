import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import cliConfig from "../deno.json" with { type: "json" };
import {
  createModule,
  createProject,
  doctor,
  type FileSystem,
  inspectModuleBoundaries,
  main,
  parseCommand,
  VERSION,
} from "./cli.ts";

class MemoryFileSystem implements FileSystem {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.directories.has(path) || this.files.has(path);
  }

  async mkdir(path: string): Promise<void> {
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      this.directories.add(segments.slice(0, index).join("/"));
    }
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    if (!this.directories.has(path.slice(0, path.lastIndexOf("/")))) {
      throw new Deno.errors.NotFound(path);
    }
    this.files.set(path, content);
  }
}

Deno.test("parseCommand recognizes help version and planned generator commands", () => {
  assertEquals(parseCommand([]), { kind: "help" });
  assertEquals(parseCommand(["--version"]), { kind: "version" });
  assertEquals(parseCommand(["new", "store-api"]), { kind: "new", directory: "store-api" });
  assertEquals(parseCommand(["generate", "module", "users"]), {
    kind: "generate",
    generator: "module",
    name: "users",
  });
  assertEquals(parseCommand(["inspect", "demo"]), {
    kind: "inspect",
    directory: "demo",
    json: false,
  });
  assertEquals(parseCommand(["doctor", "demo", "--json"]), {
    kind: "doctor",
    directory: "demo",
    json: true,
  });
  assertEquals(parseCommand(["inspect", "--json", "demo"]), {
    kind: "inspect",
    directory: "demo",
    json: true,
  });
  assertEquals(parseCommand(["doctor", "--json"]), {
    kind: "doctor",
    directory: Deno.cwd(),
    json: true,
  });
});

Deno.test("parseCommand rejects extra arguments, unknown flags, and duplicate options", () => {
  for (
    const args of [
      ["--help", "stray"],
      ["version", "--json"],
      ["new", "demo", "stray"],
      ["new", "--json"],
      ["generate", "module", "billing", "stray"],
      ["generate", "module", "--json"],
      ["inspect", "demo", "stray"],
      ["inspect", "demo", "--typo"],
      ["inspect", "--json", "--json"],
      ["doctor", "demo", "--json", "--typo"],
      ["doctor", "--json", "--json"],
    ]
  ) {
    assertThrows(() => parseCommand(args), Error, "Unknown or incomplete command");
  }
});

Deno.test("doctor identifies missing project structure with actionable findings", () => {
  assertEquals(
    doctor({
      root: "demo",
      modules: [],
      hasDenoConfig: false,
      hasApplicationEntry: false,
    }),
    [
      {
        code: "PROJECT_CONFIG_MISSING",
        severity: "error",
        message: "Missing deno.json.",
        suggestion: "Run 'hyapi new <directory>'.",
      },
      {
        code: "APPLICATION_ENTRY_MISSING",
        severity: "error",
        message: "Missing src/app.ts application entrypoint.",
      },
      {
        code: "MODULES_MISSING",
        severity: "error",
        message: "No modules found under src/modules.",
      },
    ],
  );
});

Deno.test("doctor flags direct module imports and unresolved declared ports", () => {
  const boundaries = inspectModuleBoundaries([
    {
      module: "users",
      path: "src/modules/users/users.port.ts",
      text: 'export const userDirectory = definePort("users.directory");',
    },
    {
      module: "orders",
      path: "src/modules/orders/orders.module.ts",
      text:
        'import { userDirectory } from "../users/users.port.ts";\nexport const orders = defineModule({ requires: [userDirectory] });',
    },
  ]);

  assertEquals(boundaries.analysisMode, "heuristic");
  assertEquals(boundaries.crossModuleImports, [{
    from: "orders",
    to: "users",
    specifier: "../users/users.port.ts",
    path: "src/modules/orders/orders.module.ts",
  }]);
  assertEquals(boundaries.requiredPorts, [{
    module: "orders",
    port: "users.directory",
    path: "src/modules/orders/orders.module.ts",
  }]);
  assertEquals(boundaries.providedPorts, []);
  assertEquals(
    doctor({
      root: "demo",
      modules: ["orders", "users"],
      hasDenoConfig: true,
      hasApplicationEntry: true,
      boundaries,
    }),
    [
      {
        code: "CROSS_MODULE_IMPORT",
        severity: "error",
        module: "orders",
        path: "src/modules/orders/orders.module.ts",
        message: "Module 'orders' directly imports module 'users'.",
        suggestion: "Depend on a shared Port instead.",
      },
      {
        code: "PORT_PROVIDER_MISSING",
        severity: "error",
        module: "orders",
        path: "src/modules/orders/orders.module.ts",
        message: "Module 'orders' requires port 'users.directory', but no provider was found.",
        suggestion: "Register a local or HTTP provider for this Port.",
      },
    ],
  );
});

Deno.test("boundary inspection marks heuristic analysis and unresolved references", () => {
  const boundaries = inspectModuleBoundaries([{
    module: "orders",
    path: "src/modules/orders/orders.module.ts",
    text: "export const orders = defineModule({ requires: [unknownPort] });",
  }]);
  assertEquals(boundaries.analysisMode, "heuristic");
  assertEquals(boundaries.unresolvedReferences, [{
    module: "orders",
    path: "src/modules/orders/orders.module.ts",
    reference: "unknownPort",
  }]);
  assertEquals(
    doctor({
      root: "demo",
      modules: ["orders"],
      hasDenoConfig: true,
      hasApplicationEntry: true,
      boundaries,
    })[0]?.code,
    "UNRESOLVED_PORT_REFERENCE",
  );
});

Deno.test("CLI prints help and version with actionable unsupported-command errors", async () => {
  const output: string[] = [];
  await main(["--help"], (line) => output.push(line));
  assertStringIncludes(output[0] ?? "", "hyapi new <directory>");

  await main(["--version"], (line) => output.push(line));
  assertEquals(output[1], VERSION);

  await assertRejects(
    () => main(["generate", "unknown", "store-api"]),
    Error,
    "Unsupported generator",
  );
});

Deno.test("project and module generators create a minimal structure without overwriting targets", async () => {
  const fileSystem = new MemoryFileSystem();
  await createProject("store-api", fileSystem);
  assertEquals(fileSystem.files.has("store-api/deno.json"), true);
  assertStringIncludes(
    fileSystem.files.get("store-api/deno.json") ?? "",
    `jsr:@hyapi/core@^${VERSION}`,
  );
  assertEquals(fileSystem.files.has("store-api/src/modules/health/health.module.ts"), true);
  assertEquals(fileSystem.files.has("store-api/src/modules/users/users.module.ts"), true);
  assertEquals(fileSystem.files.has("store-api/src/app_test.ts"), true);
  await assertRejects(() => createProject("store-api", fileSystem), Error, "already exists");

  assertEquals(await createModule("store-api", "Order Items", fileSystem), "order-items");
  assertEquals(
    fileSystem.files.has("store-api/src/modules/order-items/order-items.module.ts"),
    true,
  );
  assertEquals(fileSystem.files.has("store-api/src/modules/order-items/order-items_test.ts"), true);
  await assertRejects(
    () => createModule("store-api", "Order Items", fileSystem),
    Error,
    "already exists",
  );
});

Deno.test("module generation requires a project root before writing files", async () => {
  const fileSystem = new MemoryFileSystem();
  await fileSystem.mkdir("outside/src");
  await fileSystem.writeTextFile("outside/deno.json", "{}");
  await assertRejects(
    () => createModule("outside", "billing", fileSystem),
    Error,
    "cd my-api",
  );
  assertEquals(fileSystem.files.has("outside/src/modules/billing/billing.module.ts"), false);

  await fileSystem.writeTextFile("outside/src/app.ts", "");
  assertEquals(await createModule("outside", "billing", fileSystem), "billing");
});

Deno.test("CLI version matches the published package version", () => {
  assertEquals(cliConfig.version, VERSION);
});

Deno.test("new writes the starter project to a real directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "hyapi-cli-" });
  try {
    const directory = `${root}/app`;
    const output: string[] = [];
    await main(["new", directory], (line) => output.push(line));
    const stat = await Deno.stat(`${directory}/src/modules/users/users.module.ts`);
    assertEquals(stat.isFile, true);
    assertStringIncludes(output.join("\n"), `jsr:@hyapi/core@^${VERSION}`);
    assertStringIncludes(output.join("\n"), "deno task check");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("module generator rejects names that do not start with a letter", async () => {
  await assertRejects(
    () => main(["generate", "module", "2fa"], () => undefined),
    Error,
    "Module names must start with a letter.",
  );
});

Deno.test("boundary inspection resolves ports declared in shared contracts", () => {
  const boundaries = inspectModuleBoundaries(
    [{
      module: "orders",
      path: "src/modules/orders/orders.module.ts",
      text: [
        'import { userDirectoryPort } from "../../contracts/user-directory.ts";',
        "// defineModule({ requires: [ghostPort] });",
        "export const orders = defineModule({ requires: [userDirectoryPort] });",
      ].join("\n"),
    }],
    [
      {
        module: "contracts",
        path: "src/contracts/user-directory.ts",
        text: 'export const userDirectoryPort = definePort<UserDirectory>("users.directory");',
      },
      {
        module: "app",
        path: "src/app.ts",
        text: "provideHttp(userDirectoryPort, { baseUrl, contract });",
      },
    ],
  );
  assertEquals(boundaries.crossModuleImports, []);
  assertEquals(boundaries.unresolvedReferences, []);
  assertEquals(boundaries.requiredPorts, [{
    module: "orders",
    port: "users.directory",
    path: "src/modules/orders/orders.module.ts",
  }]);
  assertEquals(boundaries.providedPorts, [{
    module: "app",
    port: "users.directory",
    path: "src/app.ts",
  }]);
});
