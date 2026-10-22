import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import { createApp, type ListenOptions } from "hyapi";

function fixture() {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "echo",
        prefix: "/echo",
        routes: (route) => [
          route.get("/", { handler: ({ request }) => ({ path: new URL(request.url).pathname }) }),
        ],
      }),
    ],
  });
  const close = async () => {
    await app.close();
    await root.dispose();
  };
  return { app, close };
}

async function refused(url: URL): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return false;
  } catch {
    return true;
  }
}

test("binding an occupied port fails and leaves the application closable", async () => {
  const first = fixture();
  const second = fixture();
  try {
    const listener = await first.app.listen({ hostname: "127.0.0.1", port: 0 });
    const port = Number(listener.url.port);
    await assert.rejects(second.app.listen({ hostname: "127.0.0.1", port }));
    await second.close();
  } finally {
    await first.close();
  }
});

test("a wildcard bind reports a loopback URL that fetch can reach", async () => {
  const { app, close } = fixture();
  try {
    const listener = await app.listen({ hostname: "0.0.0.0", port: 0 });
    assert.equal(listener.url.hostname, "127.0.0.1");
    const response = await fetch(new URL("/echo/", listener.url));
    assert.deepEqual(await response.json(), { path: "/echo/" });
  } finally {
    await close();
  }
});

test("an outer fetch wrapper sees each request and may rewrite the response", async () => {
  const { app, close } = fixture();
  const seen: string[] = [];
  const wrapper: ListenOptions["fetch"] = async (request) => {
    seen.push(new URL(request.url).pathname);
    const response = await app.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-wrapped", "yes");
    return new Response(response.body, { status: response.status, headers });
  };
  try {
    const listener = await app.listen({ hostname: "127.0.0.1", port: 0, fetch: wrapper });
    const response = await fetch(new URL("/echo/", listener.url));
    assert.equal(response.headers.get("x-wrapped"), "yes");
    assert.deepEqual(await response.json(), { path: "/echo/" });
    assert.equal((await fetch(new URL("/missing", listener.url))).status, 404);
    assert.deepEqual(seen, ["/echo/", "/missing"]);
  } finally {
    await close();
  }
});

test("closing the application stops every listener it started", async () => {
  const { app, close } = fixture();
  const urls: URL[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const listener = await app.listen({ hostname: "127.0.0.1", port: 0 });
      urls.push(new URL("/echo/", listener.url));
      assert.equal((await fetch(urls[index]!)).status, 200);
    }
  } finally {
    await close();
  }
  for (const url of urls) assert.equal(await refused(url), true, url.href);
});

test("omitting the hostname binds a loopback-reachable default", async () => {
  const { app, close } = fixture();
  try {
    const listener = await app.listen({ port: 0 });
    assert.notEqual(listener.url.port, "0");
    const response = await fetch(new URL("/echo/", listener.url));
    assert.deepEqual(await response.json(), { path: "/echo/" });
  } finally {
    await close();
  }
});
