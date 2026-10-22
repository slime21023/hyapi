import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@inferdi/inferdi";
import { createApp, ForbiddenError, HttpError, reply, UnauthorizedError } from "hyapi";

test("HTTP errors accept only integer 4xx and 5xx statuses", () => {
  for (const status of [399, 600, 400.5, Number.NaN]) {
    assert.throws(() => new HttpError(status, "bad"), RangeError, String(status));
  }
  assert.equal(new HttpError(400, "low").status, 400);
  const high = new HttpError(599, "high", "CUSTOM");
  assert.deepEqual([high.status, high.code, high.message], [599, "CUSTOM", "high"]);
  assert.equal(new HttpError(404, "missing").code, "HTTP_ERROR");
});

test("authentication errors carry stable defaults", () => {
  const unauthorized = new UnauthorizedError();
  assert.deepEqual(
    [unauthorized.status, unauthorized.code, unauthorized.message, unauthorized.name],
    [401, "UNAUTHORIZED", "Authentication is required.", "UnauthorizedError"],
  );
  const forbidden = new ForbiddenError("No.");
  assert.deepEqual(
    [forbidden.status, forbidden.code, forbidden.message, forbidden.name],
    [403, "FORBIDDEN", "No.", "ForbiddenError"],
  );
  assert.ok(forbidden instanceof HttpError);
});

test("reply accepts only integer 2xx and 3xx statuses", () => {
  for (const status of [199, 400, 404, 201.5]) {
    assert.throws(() => reply(status, null), RangeError, String(status));
  }
  for (const status of [200, 204, 302, 399]) {
    assert.equal(reply(status, "value").status, status);
  }
});

test("HTTP errors serialize as Problem JSON with a fallback title", async () => {
  const root = new Container();
  const app = createApp({
    container: root,
    modules: ({ module }) => [
      module({
        name: "teapot",
        prefix: "/teapot",
        routes: (route) => [
          route.get("/", {
            handler() {
              throw new HttpError(418, "Short and stout.", "TEAPOT");
            },
          }),
        ],
      }),
    ],
  });
  try {
    const response = await app.fetch(new Request("http://localhost/teapot/"));
    assert.equal(response.status, 418);
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    assert.deepEqual(await response.json(), {
      type: "about:blank",
      title: "HTTP Error",
      status: 418,
      detail: "Short and stout.",
      code: "TEAPOT",
    });
  } finally {
    await app.close();
    await root.dispose();
  }
});
