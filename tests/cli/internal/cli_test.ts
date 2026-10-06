import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import cliConfig from "../../../packages/cli/deno.json" with { type: "json" };
import { run } from "../../../packages/cli/src/main.ts";

Deno.test("CLI explains supported commands and rejects incomplete input", async () => {
  const facade = await import(new URL("../../../packages/cli/mod.ts", import.meta.url).href);
  assertEquals(Object.keys(facade), []);

  const output: string[] = [];
  await run(["--help"], (line) => output.push(line));
  assertStringIncludes(output[0] ?? "", "hyapi generate module <name>");

  await run(["--version"], (line) => output.push(line));
  assertEquals(output[1], cliConfig.version);

  for (
    const args of [
      ["--help", "stray"],
      ["new", "demo", "stray"],
      ["generate", "module", "billing", "stray"],
      ["inspect", "demo", "--typo"],
      ["doctor", "--json", "--json"],
    ]
  ) {
    await assertRejects(() => run(args, () => undefined), Error, "Unknown or incomplete command");
  }
});

Deno.test("new and generate module write a minimal project without overwriting files", async () => {
  await withTempDir(async (root) => {
    const project = `${root}/store-api`;
    const output: string[] = [];
    await run(["new", project], (line) => output.push(line));

    assertEquals((await Deno.stat(`${project}/src/modules/users/module.ts`)).isFile, true);
    assertEquals((await Deno.stat(`${project}/tests/app_test.ts`)).isFile, true);
    assertStringIncludes(
      await Deno.readTextFile(`${project}/deno.json`),
      `@hyapi/core@^${cliConfig.version}`,
    );
    assertStringIncludes(
      await Deno.readTextFile(`${project}/src/main.ts`),
      'shutdownSignals: ["SIGINT", "SIGTERM"]',
    );
    assertStringIncludes(output.join("\n"), "deno task check");

    await assertRejects(() => run(["new", project], () => undefined), Error, "already exists");
    await run(["generate", "module", "Order Items"], () => undefined, project);
    assertEquals((await Deno.stat(`${project}/src/modules/order-items/module.ts`)).isFile, true);
    assertEquals((await Deno.stat(`${project}/tests/modules/order-items_test.ts`)).isFile, true);
    await assertRejects(
      () => run(["generate", "module", "Order Items"], () => undefined, project),
      Error,
      "already exists",
    );
  });
});

Deno.test("module generation validates its project root and module name", async () => {
  await withTempDir(async (root) => {
    await assertRejects(
      () => run(["generate", "module", "billing"], () => undefined, root),
      Error,
      "cd my-api",
    );
    await assertRejects(
      () => run(["generate", "module", "2fa"], () => undefined, root),
      Error,
      "Module names must start with a letter.",
    );
  });
});

Deno.test("inspect and doctor share module and Port boundary discovery", async () => {
  await withTempDir(async (root) => {
    const broken = `${root}/broken`;
    await writeFiles(broken, {
      "deno.json": "{}\n",
      "src/app.ts": "export {};\n",
      "src/modules/users/port.ts": 'export const users = definePort("users.directory");\n',
      "src/modules/orders/module.ts": [
        'import { users } from "../users/port.ts";',
        "export const orders = { requires: [users, unknownPort] };",
      ].join("\n"),
    });
    const inspectOutput: string[] = [];
    await run(["inspect", broken], (line) => inspectOutput.push(line));
    assertStringIncludes(inspectOutput.join("\n"), "[heuristic]");
    assertStringIncludes(inspectOutput.join("\n"), "orders -> users");

    const doctorOutput: string[] = [];
    await assertRejects(
      () => run(["doctor", broken], (line) => doctorOutput.push(line)),
      Error,
      "HyAPI doctor found",
    );
    assertStringIncludes(doctorOutput.join("\n"), "CROSS_MODULE_IMPORT");
    assertStringIncludes(doctorOutput.join("\n"), "PORT_PROVIDER_MISSING");
    assertStringIncludes(doctorOutput.join("\n"), "UNRESOLVED_PORT_REFERENCE");

    const healthy = `${root}/healthy`;
    await writeFiles(healthy, {
      "deno.json": "{}\n",
      "src/contracts/shared.ts": 'export const port = definePort("shared.remote");\n',
      "src/app.ts": [
        'import { port as remotePort } from "./contracts/shared.ts";',
        "providePort(remotePort, {});",
      ].join("\n"),
      "src/modules/orders/local.ts": 'export const port = definePort("orders.local");\n',
      "src/contracts/directory.ts": 'export const directory = definePort("users.directory");\n',
      "src/modules/users/module.ts": [
        'import { directory } from "../../contracts/directory.ts";',
        "export const users = { provides: [directory] };",
      ].join("\n"),
      "src/modules/orders/module.ts": [
        'import { port as remotePort } from "../../contracts/shared.ts";',
        'import { directory } from "../../contracts/directory.ts";',
        "export const orders = { requires: [remotePort, directory] };",
      ].join("\n"),
    });
    const healthyOutput: string[] = [];
    await run(["doctor", healthy, "--json"], (line) => healthyOutput.push(line));
    const report = JSON.parse(healthyOutput.join("\n")) as { findings: readonly unknown[] };
    assertEquals(report.findings, []);
  });
});

async function withTempDir(action: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "hyapi-cli-" });
  try {
    await action(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  await Deno.mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const separator = path.lastIndexOf("/");
    if (separator >= 0) {
      await Deno.mkdir(`${root}/${path.slice(0, separator)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${root}/${path}`, content);
  }
}
