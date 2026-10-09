import { assert, assertEquals, assertRejects } from "@std/assert";
import Type from "typebox";
import { type App, createApp, implement } from "@hyapi/core";
import { serve } from "@hyapi/core/deno";
import { defineApi, defineContract } from "@hyapi/core/contract";

const contract = defineContract({
  operations: {
    slow: {
      method: "GET",
      path: "/slow",
      query: Type.Object({ ms: Type.Integer() }),
      responses: { 200: Type.Object({ done: Type.Boolean() }) },
    },
  },
});
const api = defineApi({ info: { title: "Serve", version: "1" }, contracts: [contract] });

async function makeApp(
  log: string[],
  options: { ignoreAbort?: boolean; shutdownTimeoutMs?: number } = {},
): Promise<App> {
  return await createApp({
    api,
    onEvent: () => {},
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2_000,
    lifecycle: [{ name: "resource", stop: () => void log.push("resource stopped") }],
    implementations: [
      implement(contract, {
        slow: async ({ query }, ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, query.ms);
            if (!options.ignoreAbort) {
              ctx.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(ctx.signal.reason);
              });
            }
          });
          return { status: 200, body: { done: true } };
        },
      }),
    ],
  });
}

function listen(app: App, extra: Parameters<typeof serve>[1] = {}) {
  let ready!: (port: number) => void;
  const port = new Promise<number>((resolve) => (ready = resolve));
  const server = serve(app, {
    hostname: "127.0.0.1",
    port: 0,
    signals: [],
    onListen: (address) => ready(address.port),
    ...extra,
  });
  return { server, port };
}

Deno.test("serve answers requests and shuts down gracefully", async () => {
  const log: string[] = [];
  const { server, port } = listen(await makeApp(log));
  const base = `http://127.0.0.1:${await port}`;
  assertEquals(await (await fetch(`${base}/slow?ms=1`)).json(), { done: true });
  const inflight = fetch(`${base}/slow?ms=100`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopping = server.shutdown();
  const response = await inflight;
  assertEquals([response.status, await response.json()], [200, { done: true }]);
  await stopping;
  await server.finished;
  assertEquals(log, ["resource stopped"]);
  await assertRejects(() => fetch(`${base}/slow?ms=1`));
  assert(server.shutdown() === stopping, "shutdown is idempotent");
});

Deno.test("a wrapped handler is served while the app still closes on shutdown", async () => {
  const log: string[] = [];
  const app = await makeApp(log);
  const wrapped = async (request: Request) => {
    const response = await app.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-wrapped", "yes");
    return new Response(response.body, { status: response.status, headers });
  };
  const { server, port } = listen(app, { fetch: wrapped });
  const response = await fetch(`http://127.0.0.1:${await port}/slow?ms=1`);
  assertEquals(response.headers.get("x-wrapped"), "yes");
  await response.body?.cancel();
  await server.shutdown();
  assertEquals(log, ["resource stopped"]);
});

Deno.test("an abort signal starts the shutdown", async () => {
  const log: string[] = [];
  const controller = new AbortController();
  const { server, port } = listen(await makeApp(log), { signal: controller.signal });
  await port;
  controller.abort();
  await server.finished;
  assertEquals(log, ["resource stopped"]);
});

Deno.test("a stuck request cannot hold the shutdown past its budget", async () => {
  const log: string[] = [];
  const app = await makeApp(log, { ignoreAbort: true, shutdownTimeoutMs: 50 });
  const { server, port } = listen(app, { shutdownTimeoutMs: 300 });
  const inflight = fetch(`http://127.0.0.1:${await port}/slow?ms=60000`).then(
    async (response) => response.status,
    () => "disconnected",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = performance.now();
  await server.shutdown();
  assert(performance.now() - started < 2_000, "shutdown is bounded");
  assert(["disconnected", 503].includes(await inflight));
  assertEquals(log, ["resource stopped"]);
});

Deno.test({
  name: "an OS signal shuts a real process down gracefully",
  ignore: Deno.build.os === "windows",
  async fn() {
    const child = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        "--allow-read",
        "--unstable-no-legacy-abort",
        new URL("../../fixtures/serve_main.ts", import.meta.url).pathname,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let output = "";
    while (!/ready (\d+)/.test(output)) output += (await reader.read()).value ?? "";
    const port = output.match(/ready (\d+)/)![1];
    assertEquals(await (await fetch(`http://127.0.0.1:${port}/ping`)).json(), { ok: true });
    child.kill("SIGTERM");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      output += value;
    }
    const status = await child.status;
    await child.stderr.cancel();
    assertEquals(status.code, 0);
    assert(output.includes("resource stopped") && output.includes("stopped"), output);
  },
});
