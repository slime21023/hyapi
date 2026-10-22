import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT } from "jose";
import postgres from "postgres";
import { buildExampleApp, type ExampleApp } from "../../apps/example/src/app.ts";
import type { InventoryItem } from "../../apps/example/src/modules/inventory/store.ts";
import type { Order } from "../../apps/example/src/modules/orders/store.ts";
import type { User } from "../../apps/example/src/modules/users/store.ts";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for real PostgreSQL example tests.");
  return url;
}
const databaseUrl = requireDatabaseUrl();
const secret = "example-secret-for-tests-at-least-32-bytes";
const base = "http://localhost";
const json = (value: unknown, bearer?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  },
  body: JSON.stringify(value),
});

async function token(subject: string, role?: string): Promise<string> {
  return new SignJWT(role ? { role } : {})
    .setSubject(subject)
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(secret));
}

async function problem(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  const body = await response.json();
  assert.equal(body.status, status);
  assert.equal(body.code, code);
}

async function withDatabaseApp(
  run: (context: {
    app: ExampleApp;
    ada: string;
    lin: string;
    admin: string;
    sku: string;
    send: (path: string, init?: RequestInit) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  const suffix = crypto.randomUUID();
  const adaSubject = `ada-${suffix}`;
  const linSubject = `lin-${suffix}`;
  const adminSubject = `admin-${suffix}`;
  const sku = `ITEM-${suffix}`;
  const cleanup = postgres(databaseUrl);
  let app: ExampleApp | undefined;
  try {
    const activeApp = await buildExampleApp({ jwtSecret: secret, databaseUrl });
    app = activeApp;
    const send = (path: string, init?: RequestInit) =>
      activeApp.fetch(new Request(`${base}${path}`, init));
    await run({
      app,
      ada: await token(adaSubject),
      lin: await token(linSubject),
      admin: await token(adminSubject, "admin"),
      sku,
      send,
    });
  } finally {
    try {
      await app?.close();
      if (app) {
        await problem(
          await app.fetch(new Request(`${base}/health/live`)),
          503,
          "APPLICATION_UNAVAILABLE",
        );
      }
    } finally {
      try {
        await cleanup`DELETE FROM hyapi_example_orders WHERE owner IN (${adaSubject}, ${linSubject}, ${adminSubject})`;
        await cleanup`DELETE FROM hyapi_example_users WHERE owner IN (${adaSubject}, ${linSubject}, ${adminSubject})`;
        await cleanup`DELETE FROM hyapi_example_inventory WHERE sku = ${sku}`;
      } finally {
        await cleanup.end();
      }
    }
  }
}

async function createdUser(
  send: (path: string, init?: RequestInit) => Promise<Response>,
  bearer: string,
): Promise<User> {
  const response = await send("/v1/users/", json({ name: "Ada" }, bearer));
  assert.equal(response.status, 200);
  return response.json() as Promise<User>;
}

async function inventory(
  send: (path: string, init?: RequestInit) => Promise<Response>,
  sku: string,
  bearer: string,
): Promise<InventoryItem> {
  const response = await send(`/v1/inventory/${sku}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<InventoryItem>;
}

test("authentication precedes parsing; resource and role authorization follow validation", async () => {
  await withDatabaseApp(async ({ send, ada, lin, admin, sku }) => {
    assert.equal((await send("/health/live")).status, 200);
    assert.equal((await send("/health/ready")).status, 200);
    await problem(
      await send("/v1/users/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      401,
      "UNAUTHORIZED",
    );
    await problem(
      await send("/v1/users/", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ada}` },
        body: "{",
      }),
      400,
      "PARSE_ERROR",
    );
    await problem(await send("/v1/users/", json({ name: "" }, ada)), 400, "VALIDATION_ERROR");
    const user = await createdUser(send, ada);
    await problem(
      await send(`/v1/users/${user.id}`, { headers: { authorization: `Bearer ${lin}` } }),
      403,
      "FORBIDDEN",
    );
    const ownUser = await send(`/v1/users/${user.id}`, {
      headers: { authorization: `Bearer ${ada}` },
    });
    assert.equal(((await ownUser.json()) as User).id, user.id);
    await problem(await send("/v1/inventory/", json({ sku, quantity: 2 }, lin)), 403, "FORBIDDEN");
    await problem(
      await send("/v1/inventory/", json({ sku, quantity: -1 }, lin)),
      400,
      "VALIDATION_ERROR",
    );
    await problem(
      await send("/v1/inventory/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      401,
      "UNAUTHORIZED",
    );
    await problem(
      await send(`/v1/inventory/${sku}`, { headers: { authorization: `Bearer ${ada}` } }),
      404,
      "INVENTORY_NOT_FOUND",
    );
    assert.equal((await send("/v1/inventory/", json({ sku, quantity: 2 }, admin))).status, 200);
    await problem(
      await send("/v1/orders/", json({ userId: user.id, sku, quantity: 1 }, lin)),
      403,
      "FORBIDDEN",
    );
    await problem(
      await send("/v1/orders/", json({ userId: user.id, sku, quantity: 0 }, lin)),
      400,
      "VALIDATION_ERROR",
    );
    await problem(
      await send("/v1/orders/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      401,
      "UNAUTHORIZED",
    );
    assert.equal((await inventory(send, sku, ada)).quantity, 2);
    const response = await send("/v1/orders/", json({ userId: user.id, sku, quantity: 1 }, ada));
    assert.equal(response.status, 200);
    const order = (await response.json()) as Order;
    assert.equal(order.userId, user.id);
    assert.equal(order.owner, user.owner);
    await problem(
      await send(`/v1/orders/${order.id}`, { headers: { authorization: `Bearer ${lin}` } }),
      403,
      "FORBIDDEN",
    );
    const mine = await send(`/v1/orders/${order.id}`, {
      headers: { authorization: `Bearer ${ada}` },
    });
    assert.equal(((await mine.json()) as Order).quantity, 1);
  });
});

test("purchases persist, reject insufficient stock, and leave orders and inventory unchanged on failure", async () => {
  await withDatabaseApp(async ({ send, ada, admin, sku }) => {
    const user = await createdUser(send, ada);
    assert.equal((await send("/v1/inventory/", json({ sku, quantity: 3 }, admin))).status, 200);
    const purchased = await send("/v1/orders/", json({ userId: user.id, sku, quantity: 2 }, ada));
    assert.equal(purchased.status, 200);
    const order = (await purchased.json()) as Order;
    await problem(
      await send("/v1/orders/", json({ userId: user.id, sku, quantity: 2 }, ada)),
      409,
      "INSUFFICIENT_STOCK",
    );
    assert.equal((await inventory(send, sku, ada)).quantity, 1);
    const sql = postgres(databaseUrl);
    try {
      const [count] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::integer AS count FROM hyapi_example_orders WHERE user_id = ${user.id}`;
      assert.equal(count?.count, 1, "rejected purchase cannot persist a partial order");
    } finally {
      await sql.end();
    }
    const replacement = await buildExampleApp({ jwtSecret: secret, databaseUrl });
    try {
      const persisted = await replacement.fetch(
        new Request(`${base}/v1/orders/${order.id}`, {
          headers: { authorization: `Bearer ${ada}` },
        }),
      );
      assert.equal(((await persisted.json()) as Order).id, order.id);
      const stock = await replacement.fetch(
        new Request(`${base}/v1/inventory/${sku}`, {
          headers: { authorization: `Bearer ${ada}` },
        }),
      );
      assert.equal(((await stock.json()) as InventoryItem).quantity, 1);
    } finally {
      await replacement.close();
    }
  });
});

test("concurrent purchases never oversell a single inventory row", async () => {
  await withDatabaseApp(async ({ send, ada, admin, sku }) => {
    const user = await createdUser(send, ada);
    assert.equal((await send("/v1/inventory/", json({ sku, quantity: 1 }, admin))).status, 200);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        send("/v1/orders/", json({ userId: user.id, sku, quantity: 1 }, ada)),
      ),
    );
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    for (const response of responses.filter((candidate) => candidate.status !== 200)) {
      await problem(response, 409, "INSUFFICIENT_STOCK");
    }
    assert.equal((await inventory(send, sku, ada)).quantity, 0);
    const sql = postgres(databaseUrl);
    try {
      const [count] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::integer AS count FROM hyapi_example_orders WHERE user_id = ${user.id}`;
      assert.equal(count?.count, 1);
    } finally {
      await sql.end();
    }
  });
});

test("the PostgreSQL example responds over a real HTTP listener in Bun and Node", async () => {
  await withDatabaseApp(async ({ app, ada }) => {
    const listener = await app.listen({ hostname: "127.0.0.1", port: 0 });
    try {
      const listeningOrigin = listener.url.origin;
      assert.equal((await (await fetch(`${listeningOrigin}/health/ready`)).json()).status, "ok");
      await problem(
        await fetch(`${listeningOrigin}/v1/users/`, json({ name: "Anonymous" })),
        401,
        "UNAUTHORIZED",
      );
      const permitted = await fetch(`${listeningOrigin}/v1/users/`, json({ name: "Ada" }, ada));
      assert.equal((await permitted.json()).name, "Ada");
    } finally {
      await listener.stop();
    }
  });
});
