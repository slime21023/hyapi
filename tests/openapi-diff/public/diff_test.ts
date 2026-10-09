import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { diffOpenApi, type DiffResult, formatDiff } from "@hyapi/openapi-diff";

type Json = Record<string, unknown>;

const doc = (paths: Json, components?: Json): Json => ({
  openapi: "3.1.1",
  info: { title: "T", version: "1.0.0" },
  paths,
  ...(components ? { components } : {}),
});

const get = (operation: Json = {}, path = "/items/{id}"): Json =>
  doc({
    [path]: {
      get: { operationId: "getItem", responses: { "200": { description: "OK" } }, ...operation },
    },
  });

/** An operation that sends `schema` as a JSON request body. */
const sends = (schema: Json, components?: Json) =>
  doc({
    "/items": {
      post: {
        operationId: "createItem",
        requestBody: { required: true, content: { "application/json": { schema } } },
        responses: { "204": { description: "Created" } },
      },
    },
  }, components);

/** An operation that returns `schema` as a JSON response body. */
const returns = (schema: Json, components?: Json) =>
  doc({
    "/items": {
      get: {
        operationId: "listItems",
        responses: { "200": { description: "OK", content: { "application/json": { schema } } } },
      },
    },
  }, components);

function ok(result: DiffResult) {
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result;
}

/** `[rule, severity]` pairs, in the result's order. */
function rules(base: Json, head: Json): [string, string][] {
  return ok(diffOpenApi(base, head)).changes.map((c) => [c.rule, c.severity]);
}

const obj = (properties: Json, required: string[] = [], extra: Json = {}): Json => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});

/** Asserts the severity of a schema change when sent (request) and when received (response). */
function both(base: Json, head: Json, rule: string, request: string, response: string) {
  assertEquals(rules(sends(base), sends(head)), [[rule, request]], `request: ${rule}`);
  assertEquals(rules(returns(base), returns(head)), [[rule, response]], `response: ${rule}`);
}

// --- Operations and security ---------------------------------------------------------------------

Deno.test("operations: removed, added, deprecated, and renamed", () => {
  assertEquals(rules(get(), doc({})), [["operation-removed", "breaking"]]);
  assertEquals(rules(doc({}), get()), [["operation-added", "non-breaking"]]);
  assertEquals(rules(get(), get({ deprecated: true })), [["operation-deprecated", "non-breaking"]]);
  assertEquals(rules(get(), get({ operationId: "fetchItem" })), [[
    "operation-id-changed",
    "breaking",
  ]]);
});

Deno.test("renaming a path parameter is not a change", () => {
  const base = get({
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  });
  const head = get(
    { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
    "/items/{itemId}",
  );
  assertEquals(rules(base, head), []);
});

Deno.test("security: added, removed, and changed, including inherited root security", () => {
  const secured = (security: unknown) => get({ security });
  assertEquals(rules(secured([]), secured([{ bearer: [] }])), [["security-added", "breaking"]]);
  assertEquals(rules(secured([{ bearer: [] }]), secured([])), [[
    "security-removed",
    "non-breaking",
  ]]);
  assertEquals(rules(secured([{ bearer: ["a"] }]), secured([{ bearer: ["a", "b"] }])), [
    ["security-changed", "breaking"],
  ]);
  const root = { ...get(), security: [{ key: [] }] };
  assertEquals(rules(get(), root), [["security-added", "breaking"]]);
});

// --- Parameters and bodies -----------------------------------------------------------------------

Deno.test("parameters: removed, added, and requiredness", () => {
  const param = (required: boolean, schema: Json = { type: "string" }) =>
    get({ parameters: [{ name: "q", in: "query", required, schema }] });
  assertEquals(rules(param(false), get()), [["parameter-removed", "breaking"]]);
  assertEquals(rules(get(), param(true)), [["parameter-added", "breaking"]]);
  assertEquals(rules(get(), param(false)), [["parameter-added", "non-breaking"]]);
  assertEquals(rules(param(false), param(true)), [["parameter-became-required", "breaking"]]);
  assertEquals(rules(param(true), param(false)), [["parameter-became-optional", "non-breaking"]]);
  assertEquals(rules(param(false, { type: "string" }), param(false, { type: "integer" })), [
    ["type-changed", "breaking"],
  ]);
});

Deno.test("header parameters are matched case-insensitively", () => {
  const header = (name: string) =>
    get({ parameters: [{ name, in: "header", schema: { type: "string" } }] });
  assertEquals(rules(header("X-Trace"), header("x-trace")), []);
});

Deno.test("request bodies: added, removed, requiredness, and media types", () => {
  const body = (required: boolean, type = "application/json") =>
    get({ requestBody: { required, content: { [type]: { schema: { type: "string" } } } } });
  assertEquals(rules(get(), body(true)), [["request-body-added", "breaking"]]);
  assertEquals(rules(get(), body(false)), [["request-body-added", "non-breaking"]]);
  assertEquals(rules(body(true), get()), [["request-body-removed", "non-breaking"]]);
  assertEquals(rules(body(false), body(true)), [["request-body-became-required", "breaking"]]);
  assertEquals(rules(body(true), body(false)), [["request-body-became-optional", "non-breaking"]]);
  assertEquals(rules(body(true), body(true, "text/plain")), [
    ["media-type-removed", "breaking"],
    ["media-type-added", "non-breaking"],
  ]);
});

// --- Responses -----------------------------------------------------------------------------------

Deno.test("responses: statuses, headers, and media types", () => {
  const responses = (value: Json) => get({ responses: value });
  const desc = { description: "x" };
  assertEquals(rules(responses({ "200": desc, "404": desc }), responses({ "404": desc })), [
    ["response-status-removed", "breaking"],
  ]);
  assertEquals(rules(responses({ "200": desc, "404": desc }), responses({ "200": desc })), [
    ["response-status-removed", "non-breaking"],
  ]);
  assertEquals(rules(responses({ "200": desc }), responses({ "200": desc, "409": desc })), [
    ["response-status-added", "non-breaking"],
  ]);
  const withHeader = (required: boolean) =>
    responses({
      "200": { description: "x", headers: { ETag: { required, schema: { type: "string" } } } },
    });
  assertEquals(rules(withHeader(true), responses({ "200": desc })), [[
    "response-header-removed",
    "breaking",
  ]]);
  assertEquals(rules(withHeader(false), responses({ "200": desc })), [
    ["response-header-removed", "non-breaking"],
  ]);
  assertEquals(rules(responses({ "200": desc }), withHeader(true)), [[
    "response-header-added",
    "non-breaking",
  ]]);
  const json = responses({
    "200": { description: "x", content: { "application/json": { schema: {} } } },
  });
  assertEquals(rules(json, responses({ "200": desc })), [["media-type-removed", "breaking"]]);
});

// --- Schemas, in both directions -----------------------------------------------------------------

Deno.test("types: widening is safe to send, narrowing is safe to receive", () => {
  both({ type: "integer" }, { type: "number" }, "type-changed", "non-breaking", "breaking");
  both({ type: "number" }, { type: "integer" }, "type-changed", "breaking", "non-breaking");
  both(
    { type: "string" },
    { type: ["string", "null"] },
    "type-changed",
    "non-breaking",
    "breaking",
  );
  both({ type: "string" }, { type: "boolean" }, "type-changed", "breaking", "breaking");
});

Deno.test("enums: removing breaks senders, adding breaks receivers", () => {
  both({ enum: ["a", "b"] }, { enum: ["a"] }, "enum-value-removed", "breaking", "non-breaking");
  both({ enum: ["a"] }, { enum: ["a", "b"] }, "enum-value-added", "non-breaking", "breaking");
  // TypeBox literal unions emit anyOf of consts; they are compared as enums.
  const literals = (...values: string[]) => ({
    anyOf: values.map((v) => ({ type: "string", const: v })),
  });
  both(literals("a", "b"), literals("a"), "enum-value-removed", "breaking", "non-breaking");
});

Deno.test("properties: removed, added, and requiredness", () => {
  both(
    obj({ a: { type: "string" }, b: { type: "string" } }),
    obj({ a: { type: "string" } }),
    "property-removed",
    "non-breaking",
    "breaking",
  );
  both(
    obj({}),
    obj({ a: { type: "string" } }, ["a"]),
    "property-added",
    "breaking",
    "non-breaking",
  );
  both(obj({}), obj({ a: { type: "string" } }), "property-added", "non-breaking", "non-breaking");
  both(
    obj({ a: { type: "string" } }),
    obj({ a: { type: "string" } }, ["a"]),
    "property-became-required",
    "breaking",
    "non-breaking",
  );
  both(
    obj({ a: { type: "string" } }, ["a"]),
    obj({ a: { type: "string" } }),
    "property-became-optional",
    "non-breaking",
    "breaking",
  );
});

Deno.test("removing a property from a closed request object breaks senders", () => {
  assertEquals(
    rules(
      sends(
        obj({ a: { type: "string" }, b: { type: "string" } }, [], { additionalProperties: false }),
      ),
      sends(obj({ a: { type: "string" } }, [], { additionalProperties: false })),
    ),
    [["property-removed", "breaking"]],
  );
  assertEquals(rules(sends(obj({})), sends(obj({}, [], { additionalProperties: false }))), [
    ["additional-properties-restricted", "breaking"],
  ]);
});

Deno.test("constraints: tightening breaks senders; loosening is reported", () => {
  both(
    { type: "string", maxLength: 10 },
    { type: "string", maxLength: 5 },
    "constraint-tightened",
    "breaking",
    "non-breaking",
  );
  both(
    { type: "string", maxLength: 5 },
    { type: "string", maxLength: 10 },
    "constraint-loosened",
    "non-breaking",
    "non-breaking",
  );
  both(
    { type: "integer" },
    { type: "integer", minimum: 1 },
    "constraint-tightened",
    "breaking",
    "non-breaking",
  );
  both(
    { type: "string" },
    { type: "string", format: "email" },
    "constraint-tightened",
    "breaking",
    "non-breaking",
  );
});

Deno.test("composite schemas that change are flagged for review", () => {
  both(
    { anyOf: [{ type: "string" }, { type: "integer" }] },
    { anyOf: [{ type: "string" }, { type: "boolean" }] },
    "schema-changed",
    "breaking",
    "breaking",
  );
});

Deno.test("changes are found through $refs, nested items, and recursive schemas", () => {
  const components = (title: Json) => ({
    schemas: {
      Item: obj({
        title,
        children: { type: "array", items: { $ref: "#/components/schemas/Item" } },
      }),
    },
  });
  const list = { type: "array", items: { $ref: "#/components/schemas/Item" } };
  const result = ok(diffOpenApi(
    returns(list, components({ type: "string" })),
    returns(list, components({ type: "integer" })),
  ));
  assertEquals(result.changes.map((c) => [c.rule, c.location]), [
    ["type-changed", "response 200 application/json · [].title"],
  ]);
});

// --- Inputs and output ---------------------------------------------------------------------------

Deno.test("identical documents have no changes", async () => {
  const golden = JSON.parse(
    await Deno.readTextFile(new URL("../../fixtures/library_api.openapi.json", import.meta.url)),
  );
  assertEquals(ok(diffOpenApi(golden, structuredClone(golden))), {
    ok: true,
    changes: [],
    breaking: 0,
  });
});

Deno.test("invalid inputs are errors, never partial diffs", () => {
  const result = diffOpenApi({ ...get(), openapi: "3.0.3" }, {
    ...get(),
    components: { schemas: { A: { $ref: "other.yaml#/A" } } },
  });
  assert(!result.ok);
  assertEquals(result.errors.length, 2);
  assertStringIncludes(result.errors[0]!, "only 3.1 is supported");
  assertStringIncludes(result.errors[1]!, "bundle the document first");
  assert(!diffOpenApi(null, get()).ok);
});

Deno.test("breaking changes come first, and every format reports them", () => {
  const result = ok(diffOpenApi(
    doc({ ...get().paths as Json }),
    doc({
      "/other": { get: { operationId: "other", responses: { "200": { description: "OK" } } } },
    }),
  ));
  assertEquals(result.breaking, 1);
  assertEquals(result.changes.map((c) => c.severity), ["breaking", "non-breaking"]);
  const text = formatDiff(result, "text");
  assertStringIncludes(text, "1 breaking, 1 non-breaking change(s)");
  assertStringIncludes(
    text,
    "BREAKING  GET /items/{id} · operation: the operation was removed [operation-removed]",
  );
  const markdown = formatDiff(result, "markdown");
  assertStringIncludes(markdown, "### Breaking changes");
  assertStringIncludes(markdown, "### Other changes");
  assertEquals(JSON.parse(formatDiff(result, "json")).breaking, 1);
  assertStringIncludes(
    formatDiff(ok(diffOpenApi(get(), get())), "markdown"),
    "No changes to the API contract.",
  );
});
