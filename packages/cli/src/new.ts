import { basename, join, toFileUrl } from "jsr:@std/path@^1";
import packageConfig from "../deno.json" with { type: "json" };
import { UsageError } from "./config.ts";
import type { Io } from "./run.ts";

const TYPEBOX = "npm:typebox@~1.3.34";

/** Import map entries and the CLI invocation for published or local (unpublished) HyAPI. */
function wiring(local: string | undefined): { imports: Record<string, string>; cli: string } {
  if (local === undefined) {
    return {
      imports: { "@hyapi/core": `jsr:@hyapi/core@^${packageConfig.version}` },
      cli: `deno run -A jsr:@hyapi/cli@^${packageConfig.version}`,
    };
  }
  const file = (path: string) => toFileUrl(join(local, path)).href;
  return {
    imports: {
      "@hyapi/core": file("packages/core/mod.ts"),
      "@hyapi/core/contract": file("packages/core/contract.ts"),
      "@hyapi/core/openapi": file("packages/core/openapi.ts"),
      "@hyapi/core/deno": file("packages/core/deno.ts"),
    },
    cli: `deno run -A ${file("packages/cli/mod.ts")}`,
  };
}

function files(name: string, local: string | undefined): Record<string, string> {
  const { imports, cli } = wiring(local);
  const config = {
    tasks: {
      dev: "deno run --watch --allow-net --allow-env --unstable-no-legacy-abort src/main.ts",
      start: "deno run --allow-net --allow-env --unstable-no-legacy-abort src/main.ts",
      emit: `${cli} emit`,
      doctor: `${cli} doctor`,
      diff: `${cli} diff`,
      verify: "deno fmt --check && deno lint && deno check src/ contracts/ tests/ && " +
        `deno test && ${cli} emit --check`,
    },
    imports: { ...imports, typebox: TYPEBOX, "@std/assert": "jsr:@std/assert@^1" },
    fmt: { lineWidth: 100 },
    hyapi: { api: "./contracts/api.ts#api", openapi: "./openapi.json" },
  };
  return {
    "deno.json": `${JSON.stringify(config, null, 2)}\n`,
    ".gitattributes": "* text=auto eol=lf\n",
    ".github/workflows/ci.yml": `name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # hyapi diff compares against the document committed on main.
          fetch-depth: 0
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.9.x
      - run: deno task verify
      - name: Check API changes against main
        run: deno task diff
`,
    "README.md": `# ${name}

A contract-first API built with [HyAPI](https://github.com/slime21023/hyapi).

- \`contracts/\` holds the API contract. Change it first, then run \`deno task emit\` and commit
  \`openapi.json\`, the document your consumers receive.
- \`src/\` implements the contract. Handler types come from the contract.

\`\`\`text
deno task dev      run the server with reload
deno task emit     write openapi.json from the contracts
deno task verify   format, lint, type-check, test, and check that openapi.json is current
deno task diff     compare the contracts with openapi.json on main; breaking changes fail
\`\`\`
`,
    "contracts/greetings.ts": `import Type from "typebox";
import { defineContract, defineResponse, defineSchema, Problem } from "@hyapi/core/contract";

const T = Type;

export const Greeting = defineSchema("Greeting", T.Object({ message: T.String() }));

export const NotFound = defineResponse("NotFound", {
  description: "The resource does not exist.",
  body: Problem,
});

export const greetings = defineContract({
  tags: ["greetings"],
  operations: {
    getGreeting: {
      method: "GET",
      path: "/greetings/{name}",
      summary: "Greet someone by name",
      params: T.Object({ name: T.String({ minLength: 1, maxLength: 64 }) }),
      query: T.Object({ excited: T.Optional(T.With(T.Boolean(), { default: false })) }),
      responses: { 200: Greeting, 404: NotFound },
    },
  },
});
`,
    "contracts/api.ts": `import { defineApi } from "@hyapi/core/contract";
import { greetings } from "./greetings.ts";

export const api = defineApi({
  info: { title: ${JSON.stringify(name)}, version: "0.1.0" },
  contracts: [greetings],
});
`,
    "src/greetings.ts": `import { implement, problem } from "@hyapi/core";
import { greetings } from "../contracts/greetings.ts";

export const greetingsImplementation = implement(greetings, {
  getGreeting: ({ params, query }) => {
    if (params.name === "nobody") {
      return { status: 404, body: problem({ title: "Nobody to greet" }) };
    }
    const message = \`Hello, \${params.name}\${query.excited ? "!" : "."}\`;
    return { status: 200, body: { message } };
  },
});
`,
    "src/app.ts": `import { type App, createApp } from "@hyapi/core";
import { api } from "../contracts/api.ts";
import { greetingsImplementation } from "./greetings.ts";

export function buildApp(options: { development?: boolean } = {}): Promise<App> {
  return createApp({ api, implementations: [greetingsImplementation], ...options });
}
`,
    "src/main.ts": `import { serve } from "@hyapi/core/deno";
import { buildApp } from "./app.ts";

const app = await buildApp({ development: Deno.env.get("APP_ENV") !== "production" });
// Stops gracefully on SIGINT/SIGTERM: drains requests, then closes the app.
serve(app, { port: Number(Deno.env.get("PORT") ?? 8000) });
`,
    "tests/app_test.ts": `import { assertEquals } from "@std/assert";
import { buildApp } from "../src/app.ts";

const app = await buildApp();
const get = (path: string) => app.fetch(new Request(\`http://test\${path}\`));

Deno.test("greets by name", async () => {
  const response = await get("/greetings/Ada?excited=true");
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { message: "Hello, Ada!" });
});

Deno.test("answers 404 with a problem", async () => {
  const response = await get("/greetings/nobody");
  assertEquals(response.status, 404);
  assertEquals(response.headers.get("content-type"), "application/problem+json");
  await response.body?.cancel();
});

Deno.test("rejects input that the contract forbids", async () => {
  const response = await get(\`/greetings/\${"x".repeat(65)}\`);
  assertEquals(response.status, 400);
  await response.body?.cancel();
});
`,
  };
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    for await (const _ of Deno.readDir(dir)) return false;
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
}

/**
 * `hyapi new`: creates a project and emits its first OpenAPI document by running the project's
 * own `deno task emit`, so the project's import map resolves its contracts.
 */
export async function newCommand(dir: string, local: string | undefined, io: Io): Promise<number> {
  if (!(await isEmptyOrMissing(dir))) throw new UsageError(`${dir} is not empty`);
  for (const [path, content] of Object.entries(files(basename(dir), local))) {
    const target = join(dir, path);
    await Deno.mkdir(join(target, ".."), { recursive: true });
    await Deno.writeTextFile(target, content);
  }
  io.out(`created ${dir}`);
  const emitted = await new Deno.Command("deno", { args: ["task", "emit"], cwd: dir }).output();
  if (!emitted.success) {
    io.err(new TextDecoder().decode(emitted.stderr));
    io.err("the project was created, but emitting openapi.json failed; run 'deno task emit' in it");
    return 1;
  }
  io.out("wrote openapi.json");
  io.out(`next: cd ${basename(dir)} && deno task dev`);
  return 0;
}
