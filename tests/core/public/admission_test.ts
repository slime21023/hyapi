import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import { createApp, ForbiddenError, UnauthorizedError } from "hyapi";

const origin = "http://localhost";

function fixture() {
  const calls: string[] = [];
  const root = new Container().registerValue("secret", "ok" as string);
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "public",
        prefix: "/pub",
        routes: (route) => [
          route.get("/who", { handler: ({ identity }) => ({ anonymous: identity === undefined }) }),
        ],
      }),
      module({
        name: "private",
        prefix: "/priv",
        async authenticate(request, container) {
          calls.push(`${request.method} ${new URL(request.url).pathname}`);
          const mode = request.headers.get("authorization");
          const delay = Number(request.headers.get("x-delay") ?? "0");
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (mode === "null") return null as never;
          if (mode === "undefined") return undefined as never;
          if (mode === "boom") throw new Error("authentication internals");
          if (mode === "forbidden") throw new ForbiddenError("Account suspended.");
          if (mode !== `Bearer ${container.get("secret")}`) throw new UnauthorizedError();
          return { subject: request.headers.get("x-subject") ?? "anonymous" };
        },
        routes: (route) => [
          route.get("/who", { handler: ({ identity }) => ({ subject: identity.subject }) }),
        ],
      }),
    ],
  });
  const send = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`${origin}${path}`, init));
  const close = async () => {
    await app.close();
    await root.dispose();
  };
  return { calls, send, close };
}

test("authenticate results other than an identity fail closed", async () => {
  const { send, close } = fixture();
  try {
    for (const authorization of ["null", "undefined", "Bearer wrong"]) {
      const response = await send("/priv/who", { headers: { authorization } });
      assert.equal(response.status, 401, authorization);
      assert.equal((await response.json()).code, "UNAUTHORIZED");
    }
    const forbidden = await send("/priv/who", { headers: { authorization: "forbidden" } });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).detail, "Account suspended.");
    const failed = await send("/priv/who", { headers: { authorization: "boom" } });
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes("authentication internals"), false);
  } finally {
    await close();
  }
});

test("path and method variants never reach a protected handler without authentication", async () => {
  const { calls, send, close } = fixture();
  try {
    assert.equal((await send("/priv/who/")).status, 401);
    assert.equal((await send("/priv/who", { method: "HEAD" })).status, 401);
    assert.deepEqual(calls, ["GET /priv/who/", "HEAD /priv/who"]);
    calls.length = 0;
    assert.equal((await send("//priv/who")).status, 404);
    assert.equal((await send("/priv/who", { method: "POST" })).status, 404);
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

test("public routes skip authentication and receive no identity", async () => {
  const { calls, send, close } = fixture();
  try {
    const response = await send("/pub/who", { headers: { authorization: "Bearer ok" } });
    assert.deepEqual(await response.json(), { anonymous: true });
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

test("interleaved asynchronous authentication keeps each identity with its own request", async () => {
  const { send, close } = fixture();
  try {
    const headers = (subject: string, delay: number) => ({
      authorization: "Bearer ok",
      "x-subject": subject,
      "x-delay": String(delay),
    });
    const responses = await Promise.all([
      send("/priv/who", { headers: headers("slow", 40) }),
      send("/priv/who", { headers: headers("fast", 0) }),
      send("/priv/who", { headers: headers("middle", 20) }),
    ]);
    assert.deepEqual(await Promise.all(responses.map((response) => response.json())), [
      { subject: "slow" },
      { subject: "fast" },
      { subject: "middle" },
    ]);
  } finally {
    await close();
  }
});
