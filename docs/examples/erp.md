# Modular ERP example

The private [ERP application](https://github.com/slime21023/hyapi/tree/main/apps/example/src) is a **single-tenant, PostgreSQL-backed modular monolith**, not a complete ERP product or an architecture imposed by HyAPI. HyAPI composes HTTP routes, validates inputs and outputs, and exposes optional OpenAPI. This application decides its own business boundaries, JWT and role policy, storage, SQL transactions, and request logging.

The [Quickstart](../guide/quickstart.md) needs no database; use it before this example.

## Follow the components

The application keeps components small and assembles them linearly:

- `modules/users/store.ts`, `modules/inventory/store.ts`, and `modules/orders/store.ts` — application-owned SQL tables and operations.
- `modules/orders/purchase.ts` — `OrderActions` reserves stock and inserts an order in one transaction.
- `modules/users/routes.ts`, `modules/inventory/routes.ts`, and `modules/orders/routes.ts` — schemas, named routes, ownership checks, and named HyAPI modules.
- `modules/health.ts` and `stream.ts` — public liveness/readiness and a stream that owns its timer.
- `auth.ts`, `container.ts`, and `db.ts` — JWT verification, the InferDI graph, and PostgreSQL startup.
- `app.ts` and `main.ts` — compose four modules and OpenAPI, inject environment, bind a listener, trace requests, and shut down resources.

Orders deliberately use the users and inventory stores; no repository interfaces or mandated `domain/` directory hide that choice. The purchase action illustrates where this application places its transaction boundary:

<<< ../../apps/example/src/modules/orders/purchase.ts

The [order route](https://github.com/slime21023/hyapi/blob/main/apps/example/src/modules/orders/routes.ts) validates and authorizes an owned user, then calls `scope.get("orders").purchase(...)`. The [InferDI container](../guide/di-lifecycle.md) registers that scoped service; [`buildExampleApp`](https://github.com/slime21023/hyapi/blob/main/apps/example/src/app.ts) composes health, users, inventory, and orders. JWT verification and business authorization are not Core features. See [authentication](../guide/auth.md), [modules](../guide/modules.md), and [OpenAPI](../guide/openapi.md) for each HyAPI contract.

## Start the application

Install Bun 1.4.0 and Node 24+, and provide a reachable **PostgreSQL 16 database dedicated to this example**. From the repository root, copy `.env.example` to a private `.env` (`Copy-Item .env.example .env` in PowerShell), set `DATABASE_URL` to that database, and replace `JWT_SECRET` with a cryptographically random secret of at least 32 UTF-8 bytes. Generate a candidate secret with:

```sh
bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

The example defaults to `HOST=127.0.0.1` and `PORT=8000`. `.env` is ignored by git. Neither the framework nor the application loads it implicitly; opt in explicitly:

```sh
bun install --frozen-lockfile
bun --env-file=.env run dev
```

Startup creates tables, **not sample users or stock**. For built ESM instead, run `bun run build` and `node --env-file=.env apps/example/dist/main.js`. Once listening, `GET http://127.0.0.1:8000/health/live` and `/health/ready` return HTTP 200 with `{"status":"ok"}`; `/openapi/json` returns the OpenAPI document. PostgreSQL readiness failure returns 503 with problem code `DATABASE_UNAVAILABLE`. Missing or invalid startup configuration fails before listening.

## Available endpoints

Protected routes require `Authorization: Bearer <token>` signed with the configured `JWT_SECRET` using HS256 and containing a `sub` claim. An admin additionally carries `role: "admin"`. This example **verifies** tokens but does not issue them or provide a login endpoint.

| Method and path          | Input                                                      | Successful result                                             | Access                      |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------- | --------------------------- |
| `GET /health/live`       | None                                                       | 200 `{"status":"ok"}`                                         | Public                      |
| `GET /health/ready`      | None                                                       | 200 `{"status":"ok"}`                                         | Public; checks PostgreSQL   |
| `GET /health/stream`     | None                                                       | NDJSON sequences 1, 2, 3                                      | Public; stream owns cleanup |
| `POST /v1/users/`        | `{"name":"Ada"}`                                           | 200 user with generated `id`, `name`, and `owner`             | Bearer subject              |
| `GET /v1/users/:id`      | UUID in the path                                           | 200 owned user                                                | Owner                       |
| `POST /v1/inventory/`    | `{"sku":"ITEM-1","quantity":3}`                            | 200 stock with `sku` and `quantity`                           | Admin bearer                |
| `GET /v1/inventory/:sku` | Nonempty SKU in the path                                   | 200 current stock                                             | Bearer                      |
| `POST /v1/orders/`       | `{"userId":"<returned UUID>","sku":"ITEM-1","quantity":2}` | 200 new order with `id`, `userId`, `sku`, `quantity`, `owner` | Referenced user's owner     |
| `GET /v1/orders/:id`     | UUID in the path                                           | 200 owned order                                               | Order owner                 |

## Exercise a purchase

Save the following as `erp-walkthrough.ts` **in the repository root**. It uses this repository's `jose` dependency to sign demonstration tokens with the same secret as the running application. The distinct subject and SKU on every run prevent the walkthrough from overwriting its earlier inventory; the created rows still persist.

```ts
import assert from "node:assert/strict";
import { SignJWT } from "jose";

const secret = process.env.JWT_SECRET;
if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
  throw new Error("Set JWT_SECRET to the same 32-byte-or-longer secret as the server.");
}
const key = new TextEncoder().encode(secret);
const origin = "http://127.0.0.1:8000";
const suffix = crypto.randomUUID();
const subject = `ada-${suffix}`;
const sku = `ITEM-${suffix}`;

async function token(tokenSubject: string, role?: string): Promise<string> {
  return new SignJWT(role ? { role } : {})
    .setSubject(tokenSubject)
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);
}

async function post(path: string, value: unknown, bearer: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(value),
  });
}

async function stock(bearer: string): Promise<{ sku: string; quantity: number }> {
  const response = await fetch(`${origin}/v1/inventory/${sku}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { sku: string; quantity: number };
}

const owner = await token(subject);
const admin = await token(`admin-${suffix}`, "admin");
const created = await post("/v1/users/", { name: "Ada" }, owner);
assert.equal(created.status, 200);
const user = (await created.json()) as { id: string; owner: string };
assert.equal(user.owner, subject);

const stocked = await post("/v1/inventory/", { sku, quantity: 3 }, admin);
assert.equal(stocked.status, 200);
const purchased = await post("/v1/orders/", { userId: user.id, sku, quantity: 2 }, owner);
assert.equal(purchased.status, 200);
const order = (await purchased.json()) as { userId: string; quantity: number; owner: string };
assert.equal(order.userId, user.id);
assert.equal(order.owner, subject);
assert.equal(order.quantity, 2);
assert.deepEqual(await stock(owner), { sku, quantity: 1 });

const rejected = await post("/v1/orders/", { userId: user.id, sku, quantity: 2 }, owner);
assert.equal(rejected.status, 409);
assert.equal(rejected.headers.get("content-type"), "application/problem+json");
const problem = (await rejected.json()) as { status: number; code: string };
assert.equal(problem.status, 409);
assert.equal(problem.code, "INSUFFICIENT_STOCK");
assert.deepEqual(await stock(owner), { sku, quantity: 1 });
console.log(JSON.stringify({ purchased: order.quantity, remaining: 1, rejected: problem.code }));
```

In another terminal, run:

```sh
bun --env-file=.env erp-walkthrough.ts
```

Expected output: `{"purchased":2,"remaining":1,"rejected":"INSUFFICIENT_STOCK"}`. The failed purchase does not remove stock or create an order; the [integration tests](https://github.com/slime21023/hyapi/blob/main/tests/example/v05_erp_test.ts) also verify rollback, persistence across application restarts, and concurrent purchases. This manual sequence does not prove those additional properties. Stop the server normally when finished; remove demonstration rows from your dedicated database if they are no longer needed.
