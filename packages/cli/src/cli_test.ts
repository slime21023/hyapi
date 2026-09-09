import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
    this.directories.add(path);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
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

  await createModule("store-api", "Order Items", fileSystem);
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
