import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExampleApp } from "../../apps/example/src/app.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for real PostgreSQL example tests.");
const jwtSecret = "example-secret-for-tests-at-least-32-bytes";
const origin = "http://localhost";

test("OpenAPI projects the same public and protected Valibot route schemas", async () => {
  const app = await buildExampleApp({ jwtSecret, databaseUrl });
  try {
    const response = await app.fetch(new Request(`${origin}/openapi/json`));
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.info.version, "0.5.0");
    assert.deepEqual(document.components.securitySchemes.BearerAuth, {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    for (const path of ["/health/live", "/health/ready", "/health/stream"]) {
      assert.ok(document.paths[path]?.get, `Missing public ${path}`);
      assert.equal(document.paths[path].get.security, undefined);
    }
    for (const [path, methods] of [
      ["/v1/users/", ["post"]],
      ["/v1/users/{id}", ["get"]],
      ["/v1/inventory/", ["post"]],
      ["/v1/inventory/{sku}", ["get"]],
      ["/v1/orders/", ["post"]],
      ["/v1/orders/{id}", ["get"]],
    ] as const) {
      for (const method of methods) {
        const operation = document.paths[path]?.[method];
        assert.ok(operation, `Missing ${method.toUpperCase()} ${path}`);
        assert.deepEqual(operation.security, [{ BearerAuth: [] }]);
      }
    }
    assert.equal(
      document.paths["/v1/orders/"].post.requestBody.content["application/json"].schema.properties
        .quantity.minimum,
      1,
    );
    assert.equal(
      document.paths["/v1/orders/"].post.requestBody.content["application/json"].schema.properties
        .userId.format,
      "uuid",
    );
    assert.equal(
      document.paths["/v1/users/"].post.responses["200"].content["application/json"].schema
        .properties.owner.type,
      "string",
    );
    const denied = await app.fetch(
      new Request(`${origin}/v1/orders/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    assert.equal(denied.status, 401);
  } finally {
    await app.close();
  }
});

test("a streaming response outlives its request and owns its timer until completion or cancellation", async () => {
  const app = await buildExampleApp({ jwtSecret, databaseUrl });
  const response = await app.fetch(new Request(`${origin}/health/stream`));
  assert.equal(response.status, 200);
  try {
    const cancelled = await app.fetch(new Request(`${origin}/health/stream`));
    const reader = cancelled.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    await app.close();
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }]);
  } finally {
    await app.close();
  }
});
