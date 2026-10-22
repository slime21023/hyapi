import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../../scripts/process.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

interface ListenerProcess {
  readonly pid: number;
  readonly port: number;
}

async function bounded<T>(operation: Promise<T>, ms = 10_000): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Process fixture watchdog expired.")),
    ms,
  );
  try {
    return await Promise.race([operation, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function listenerProcess(root: string, name: string): Promise<ListenerProcess> {
  const deadlineMs = Date.now() + 10_000;
  for (;;) {
    try {
      return JSON.parse(await readFile(join(root, `${name}.json`), "utf8")) as ListenerProcess;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadlineMs) {
        throw error;
      }
    }
    await delay(10);
  }
}

async function assertReleased(port: number): Promise<void> {
  const listener = createServer();
  try {
    const listening = once(listener, "listening");
    listener.listen({ host: "127.0.0.1", port });
    await bounded(listening);
  } finally {
    if (listener.listening) {
      const closed = once(listener, "close");
      listener.close();
      await bounded(closed);
    }
  }
}

// A fixture-only control socket cleans up its own process independently of runProcess.
async function stopFixture(port: number, token: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(2_000, () => {
    socket.destroy();
    reject(new Error("Process fixture cleanup timed out."));
  });
  socket.resume();
  socket.once("connect", () => socket.end(token));
  socket.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ECONNREFUSED") resolve();
    else reject(error);
  });
  socket.once("close", () => resolve());
  await promise;
}

const treeFixture = String.raw`
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
const [root, mode, token] = process.argv.slice(2);
setTimeout(() => process.exit(98), 20_000).unref();
const listener = createServer((socket) => {
  socket.once("data", (data) => {
    if (data.toString() === token) {
      socket.end("stopped");
      listener.close(() => process.exit(0));
    } else {
      socket.end();
    }
  });
});
listener.listen({ host: "127.0.0.1", port: 0 });
await once(listener, "listening");
const name = mode === "descendant" ? "descendant" : "parent";
const path = join(root, name + ".json");
await writeFile(path + ".tmp", JSON.stringify({ pid: process.pid, port: listener.address().port }));
await rename(path + ".tmp", path);
if (mode !== "descendant") {
  spawn(process.execPath, [fileURLToPath(import.meta.url), root, "descendant", token], {
    stdio: "inherit",
    // Windows otherwise kills the ordinary child when this root exits.
    detached: process.platform === "win32" && mode === "orphan",
    windowsHide: true,
  }).on("error", (error) => { throw error; });
  if (mode === "orphan") {
    for (;;) {
      try { await access(join(root, "descendant.json")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(10);
    }
    const closed = once(listener, "close");
    listener.close();
    await closed;
    process.exit(0);
  }
}
`;

test("runProcess rejects nonzero exits", async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ["--eval", "process.exitCode = 17"], repository),
    /failed \(17\)/,
  );
});

test("runProcess retains native spawn errors", async () => {
  await assert.rejects(() => runProcess(`hyapi-missing-${randomUUID()}`, [], repository), {
    code: "ENOENT",
  });
});

test("runProcess terminates a timed-out parent and descendant before rejecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "hyapi-process-tree-"));
  const token = randomUUID();
  let parent: ListenerProcess | undefined;
  let descendant: ListenerProcess | undefined;
  try {
    const script = join(root, "tree.mjs");
    await writeFile(script, treeFixture);
    const outcome = runProcess(
      process.execPath,
      [script, root, "parent", token],
      repository,
      3_000,
    ).catch((error: unknown) => error);
    parent = await listenerProcess(root, "parent");
    descendant = await listenerProcess(root, "descendant");
    assert.ok((await bounded(outcome)) instanceof Error);
    await assertReleased(parent.port);
    await assertReleased(descendant.port);
  } finally {
    if (descendant) await stopFixture(descendant.port, token);
    if (parent) await stopFixture(parent.port, token);
    await rm(root, { recursive: true, force: true });
  }
});
