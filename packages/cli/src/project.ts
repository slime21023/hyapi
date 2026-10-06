export async function createProject(directory: string, coreVersion: string): Promise<void> {
  if (await pathExists(directory)) {
    throw new Error(`Cannot create project: '${directory}' already exists.`);
  }
  await Deno.mkdir(directory, { recursive: true });
  await writeFiles(directory, {
    "deno.json": projectConfig(coreVersion),
    "src/main.ts": projectMain(),
    "src/app.ts": projectApp(),
    "tests/app_test.ts": projectAppTest(),
    "src/modules/health/module.ts": healthModule(),
    "src/modules/users/module.ts": moduleTemplate("users"),
    "src/modules/users/routes.ts": routeTemplate("users"),
    "src/modules/users/schema.ts": schemaTemplate("users"),
    "tests/modules/users_test.ts": testTemplate("users"),
  });
}

export async function createModule(root: string, name: string): Promise<string> {
  const normalized = normalizeName(name);
  if (!(await isFile(`${root}/deno.json`)) || !(await isFile(`${root}/src/app.ts`))) {
    throw new Error(
      `Cannot generate module outside a HyAPI project root: '${root}' needs deno.json and src/app.ts. ` +
        "Run 'cd my-api' (or your project directory) and retry.",
    );
  }
  const directory = `${root}/src/modules/${normalized}`;
  if (await pathExists(directory)) {
    throw new Error(`Cannot create module: '${directory}' already exists.`);
  }
  await Deno.mkdir(directory, { recursive: true });
  await writeFiles(directory, {
    "module.ts": moduleTemplate(normalized),
    "routes.ts": routeTemplate(normalized),
    "schema.ts": schemaTemplate(normalized),
  });
  await writeFiles(root, { [`tests/modules/${normalized}_test.ts`]: testTemplate(normalized) });
  return normalized;
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const separator = path.lastIndexOf("/");
    if (separator >= 0) {
      await Deno.mkdir(`${root}/${path.slice(0, separator)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${root}/${path}`, content, { createNew: true });
  }
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

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
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

function projectConfig(coreVersion: string): string {
  return JSON.stringify(
    {
      imports: {
        "@hyapi/core": `jsr:@hyapi/core@^${coreVersion}`,
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
  return `import { serve } from "@hyapi/core";
import { app } from "./app.ts";

const hostname = Deno.env.get("HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("PORT") ?? "8000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

const server = serve(app, {
  hostname,
  port,
  shutdownSignals: ["SIGINT", "SIGTERM"],
});
await server.finished;
`;
}

function projectApp(): string {
  return [
    'import { createApplication, defineConfig } from "@hyapi/core";',
    'import { healthModule } from "./modules/health/module.ts";',
    'import { usersModule } from "./modules/users/module.ts";',
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
    'import { app } from "../src/app.ts";',
    "",
    'Deno.test("starter application exposes health and OpenAPI", async () => {',
    '  assertEquals((await app.request("http://test/health/live")).status, 200);',
    '  assertEquals((await app.request("http://test/openapi.json")).status, 200);',
    "});",
  ].join("\n") + "\n";
}

function healthModule(): string {
  return [
    'import type { Module } from "@hyapi/core";',
    "",
    "export const healthModule: Module = {",
    '  name: "health",',
    "  setup(module) {",
    "    module.route({",
    '      method: "get",',
    '      path: "/health/live",',
    '      handler: ({ ok }) => ok({ status: "ok" }),',
    "    });",
    "  },",
    "};",
  ].join("\n") + "\n";
}

function moduleTemplate(name: string): string {
  return [
    'import type { Module } from "@hyapi/core";',
    `import { register${pascalCase(name)}Routes } from "./routes.ts";`,
    "",
    `export const ${camelCase(name)}Module: Module = {`,
    `  name: "${name}",`,
    "  setup(module) {",
    `    register${pascalCase(name)}Routes(module);`,
    "  },",
    "};",
  ].join("\n") + "\n";
}

function routeTemplate(name: string): string {
  return [
    'import type { ModuleApi } from "@hyapi/core";',
    `import { ${pascalCase(name)}ResponseSchema } from "./schema.ts";`,
    "",
    `export function register${pascalCase(name)}Routes(module: ModuleApi): void {`,
    "  module.route({",
    '    method: "get",',
    `    path: "/${name}",`,
    `    responses: { 200: ${pascalCase(name)}ResponseSchema },`,
    `    handler: ({ ok }) => ok({ module: "${name}" }),`,
    "  });",
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
    `import { ${camelCase(name)}Module } from "../../src/modules/${name}/module.ts";`,
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
