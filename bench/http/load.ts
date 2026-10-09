// HTTP load and memory baseline (Review 0001 F5.9). Results: _adr/baselines/http-load.md.
//
// Starts bench/http/server.ts in its own process, so that the clients do not share its event loop,
// then measures throughput and latency at several concurrency levels over real HTTP, and the
// server's heap after collecting garbage between rounds of requests.
//
// Usage: deno task bench:http [seconds per run, default 5]
const SECONDS = Number(Deno.args[0] ?? 5);
const CONCURRENCY = [1, 16, 64];

interface Scenario {
  readonly name: string;
  readonly request: (base: string) => Request;
}

const scenarios: readonly Scenario[] = [
  { name: "GET /items/{id}", request: (base) => new Request(`${base}/items/42`) },
  {
    name: "POST /items (JSON body)",
    request: (base) =>
      new Request(`${base}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "An item", tags: ["a", "b"] }),
      }),
  },
];

/** Starts the server process and waits for its port. */
async function startServer(): Promise<{ base: string; process: Deno.ChildProcess }> {
  const process = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--unstable-no-legacy-abort",
      "--v8-flags=--expose-gc",
      new URL("./server.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!/listening \d+/.test(text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error("the server exited before listening");
    text += value;
  }
  reader.releaseLock();
  const port = /listening (\d+)/.exec(text)![1];
  return { base: `http://127.0.0.1:${port}`, process };
}

/** One client: sends requests back to back until the deadline, recording each latency. */
async function client(scenario: Scenario, base: string, deadline: number, latencies: number[]) {
  while (performance.now() < deadline) {
    const started = performance.now();
    const response = await fetch(scenario.request(base));
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`${scenario.name} answered ${response.status}`);
    latencies.push(performance.now() - started);
  }
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

async function measure(scenario: Scenario, base: string, concurrency: number) {
  const latencies: number[] = [];
  const deadline = performance.now() + SECONDS * 1_000;
  await Promise.all(
    Array.from({ length: concurrency }, () => client(scenario, base, deadline, latencies)),
  );
  const sorted = latencies.sort((a, b) => a - b);
  return {
    rps: Math.round(sorted.length / SECONDS),
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
  };
}

async function heapMb(base: string): Promise<{ heap: number; rss: number }> {
  const memory = await (await fetch(`${base}/memory`)).json();
  return { heap: memory.heapUsed / 2 ** 20, rss: memory.rss / 2 ** 20 };
}

/** Sends `count` requests with 16 clients. */
async function burst(scenario: Scenario, base: string, count: number) {
  let remaining = count;
  const worker = async () => {
    while (remaining-- > 0) await (await fetch(scenario.request(base))).arrayBuffer();
  };
  await Promise.all(Array.from({ length: 16 }, worker));
}

const { base, process } = await startServer();
try {
  // Warm up the server's validators and the JIT.
  for (const scenario of scenarios) await burst(scenario, base, 2_000);

  console.log(`| Scenario | Concurrency | Requests/s | p50 (ms) | p99 (ms) |`);
  console.log(`| --- | ---: | ---: | ---: | ---: |`);
  for (const scenario of scenarios) {
    for (const concurrency of CONCURRENCY) {
      const { rps, p50, p99 } = await measure(scenario, base, concurrency);
      console.log(
        `| ${scenario.name} | ${concurrency} | ${rps} | ${p50.toFixed(2)} | ${p99.toFixed(2)} |`,
      );
    }
  }

  console.log(`\n| After | Heap used (MiB) | RSS (MiB) |`);
  console.log(`| --- | ---: | ---: |`);
  const rounds = [0, 50_000, 50_000, 50_000];
  let total = 0;
  for (const count of rounds) {
    await burst(scenarios[0]!, base, count / 2);
    await burst(scenarios[1]!, base, count / 2);
    total += count;
    const { heap, rss } = await heapMb(base);
    console.log(`| ${total} more requests | ${heap.toFixed(1)} | ${rss.toFixed(1)} |`);
  }
} finally {
  process.kill();
  await process.status;
}
