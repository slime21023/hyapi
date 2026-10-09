import { assertEquals } from "@std/assert";
import { SignJWT } from "jsr:@panva/jose@^6";
import type { AppEvent } from "@hyapi/core";
import { buildExample } from "../../../apps/example/src/app.ts";

const secret = "an-example-secret-of-at-least-32-bytes";
const events: AppEvent[] = [];
const { app, fetch } = await buildExample({
  jwtSecret: secret,
  development: true,
  corsOrigins: ["https://app.example.com"],
  log: (event) => void events.push(event),
});
const token = await new SignJWT({ sub: "librarian", scope: "books:write", aud: "library-api" })
  .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h")
  .sign(new TextEncoder().encode(secret));

const call = (method: string, path: string, init: RequestInit = {}) =>
  fetch(new Request(`http://example${path}`, { method, ...init }));

Deno.test("the example serves its contract end to end", async () => {
  const list = await call("GET", "/books?q=kindred");
  assertEquals([list.status, (await list.json()).total], [200, 1]);

  const body = JSON.stringify({ title: "Dune", author: "Frank Herbert", year: 1965 });
  const anonymous = await call("POST", "/books", {
    body,
    headers: { "content-type": "application/json" },
  });
  assertEquals(anonymous.status, 401);
  await anonymous.body?.cancel();

  const created = await call("POST", "/books", {
    body,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });
  const book = await created.json();
  assertEquals([created.status, created.headers.get("location")], [201, `/books/${book.id}`]);

  const missing = await call("GET", `/books/${crypto.randomUUID()}`);
  assertEquals([missing.status, missing.headers.get("content-type")], [
    404,
    "application/problem+json",
  ]);
  await missing.body?.cancel();

  const csv = await call("GET", "/books.csv");
  assertEquals(csv.headers.get("content-type"), "text/csv");
  assertEquals((await csv.text()).split("\n")[0], "id,title,author,year,available");

  const health = await call("GET", "/health");
  assertEquals([health.status, (await health.json()).status], [200, "healthy"]);

  const preflight = await call("OPTIONS", "/books", {
    headers: { origin: "https://app.example.com", "access-control-request-method": "POST" },
  });
  assertEquals(preflight.status, 204);

  assertEquals(
    events.some((e) => e.type === "operation.end" && e.operationId === "createBook"),
    true,
  );
});

Deno.test("the example serves a public and an internal document, with request IDs", async () => {
  const published = await call("GET", "/openapi.json");
  const internal = await call("GET", "/internal/openapi.json");
  const publicPaths = Object.keys((await published.json()).paths);
  const internalPaths = Object.keys((await internal.json()).paths);
  assertEquals(publicPaths.includes("/health"), false, "operational endpoints stay internal");
  assertEquals(internalPaths.includes("/health"), true);
  assertEquals(publicPaths.every((path) => internalPaths.includes(path)), true);

  const anonymous = await call("POST", "/books", { body: "{}" });
  const id = anonymous.headers.get("x-request-id");
  await anonymous.body?.cancel();
  const denied = events.find((event) => event.type === "security.denied" && event.requestId === id);
  assertEquals(denied?.type === "security.denied" && denied.reason, "missing");
});

Deno.test("the example closes gracefully", async () => {
  await app.close();
  const health = await call("GET", "/health");
  assertEquals(health.status, 503);
  await health.body?.cancel();
});
