import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import Type from "typebox";
import { headerObject, parseRequestBody, queryObject, SchemaValidator } from "./validation.ts";
import { AppError, ResponseValidationError, ValidationError } from "./errors.ts";

Deno.test("SchemaValidator - validates valid payloads and coerces types", () => {
  const validator = new SchemaValidator();
  const schema = Type.Object({
    name: Type.String({ minLength: 2 }),
    age: Type.Integer({ minimum: 0 }),
    active: Type.Boolean(),
    tags: Type.Array(Type.String()),
  });

  // String numbers/booleans coerced
  const input = {
    name: "Ada",
    age: "36",
    active: "true",
    tags: ["math", "logic"],
  };

  const result = validator.validate(schema, input, "query");
  assertEquals(result, {
    name: "Ada",
    age: 36,
    active: true,
    tags: ["math", "logic"],
  });
});

Deno.test("SchemaValidator - applies request defaults before coercion", () => {
  const validator = new SchemaValidator();
  const schema = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, default: 10 })),
    active: Type.Optional(Type.Boolean({ default: true })),
  });

  const result = validator.validate(schema, {}, "query");
  assertEquals(result, { limit: 10, active: true });
});

Deno.test("SchemaValidator - throws ValidationError for invalid inputs", () => {
  const validator = new SchemaValidator();
  const schema = Type.Object({
    email: Type.String({ format: "email" }),
    id: Type.String({ format: "uuid" }),
    created: Type.String({ format: "date-time" }),
  });

  // Valid formats
  const valid = validator.validate<{ email: string; id: string; created: string }>(
    schema,
    {
      email: "user@example.com",
      id: "550e8400-e29b-41d4-a716-446655440000",
      created: "2026-08-28T12:00:00Z",
    },
    "body",
  );
  assertEquals(valid.email, "user@example.com");

  // Invalid formats
  assertThrows(
    () =>
      validator.validate(
        schema,
        {
          email: "not-an-email",
          id: "not-uuid",
          created: "invalid-date",
        },
        "body",
      ),
    ValidationError,
  );
});

Deno.test("SchemaValidator - throws ResponseValidationError when source is response", () => {
  const validator = new SchemaValidator();
  const schema = Type.Object({
    success: Type.Boolean(),
  });

  assertThrows(
    () => validator.validate(schema, { success: "not-boolean" }, "response"),
    ResponseValidationError,
  );
});

Deno.test("queryObject - aggregates single and multi-value search parameters", () => {
  const req = new Request("http://test/api?page=1&tag=ts&tag=deno&sort=desc");
  const query = queryObject(req);
  assertEquals(query, {
    page: "1",
    tag: ["ts", "deno"],
    sort: "desc",
  });
});

Deno.test("queryObject - preserves inherited-name keys and duplicate values", () => {
  const req = new Request(
    "http://test/api?constructor=first&constructor=second&__proto__=first&__proto__=second&toString=one&tag=a&tag=b",
  );
  const query = queryObject(req);
  assertEquals(
    query,
    Object.fromEntries([
      ["constructor", ["first", "second"]],
      ["__proto__", ["first", "second"]],
      ["toString", "one"],
      ["tag", ["a", "b"]],
    ]),
  );
  assertEquals(Object.getPrototypeOf(query), Object.prototype);
});

Deno.test("headerObject - extracts all headers into a plain object", () => {
  const headers = new Headers({
    "x-custom-header": "custom-val",
    "authorization": "Bearer token",
  });
  const obj = headerObject(headers);
  assertEquals(obj["x-custom-header"], "custom-val");
  assertEquals(obj["authorization"], "Bearer token");
});

Deno.test("parseRequestBody - returns undefined for GET, HEAD, or Content-Length 0", async () => {
  const getReq = new Request("http://test/", { method: "GET" });
  assertEquals(await parseRequestBody(getReq), undefined);

  const headReq = new Request("http://test/", { method: "HEAD" });
  assertEquals(await parseRequestBody(headReq), undefined);

  const zeroLengthReq = new Request("http://test/", {
    method: "POST",
    headers: { "content-length": "0" },
  });
  assertEquals(await parseRequestBody(zeroLengthReq), undefined);
});

Deno.test("parseRequestBody - does not trust Content-Length and ignores the media type of bodyless requests", async () => {
  const mismatchedLengthReq = new Request("http://test/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "0",
    },
    body: JSON.stringify({ key: "value" }),
  });
  assertEquals(await parseRequestBody(mismatchedLengthReq), { key: "value" });

  const emptyUnsupportedReq = new Request("http://test/", {
    method: "POST",
    headers: { "content-type": "text/plain" },
  });
  assertEquals(await parseRequestBody(emptyUnsupportedReq), undefined);
});

Deno.test("parseRequestBody - parses valid JSON and throws AppError on invalid JSON", async () => {
  const validJsonReq = new Request("http://test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "value", count: 42 }),
  });
  assertEquals(await parseRequestBody(validJsonReq), { key: "value", count: 42 });

  const invalidJsonReq = new Request("http://test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ broken json }",
  });
  await assertRejects(
    () => parseRequestBody(invalidJsonReq),
    AppError,
    "Request body is not valid JSON.",
  );
});

Deno.test("parseRequestBody - parses application/x-www-form-urlencoded payloads", async () => {
  const formReq = new Request("http://test/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "name=Bob&role=admin&role=editor",
  });
  assertEquals(await parseRequestBody(formReq), {
    name: "Bob",
    role: ["admin", "editor"],
  });
});

Deno.test("parseRequestBody - parses multipart/form-data payloads", async () => {
  const formData = new FormData();
  formData.append("username", "alice");
  formData.append("hobbies", "coding");
  formData.append("hobbies", "music");

  const multipartReq = new Request("http://test/", {
    method: "POST",
    body: formData,
  });
  const result = (await parseRequestBody(multipartReq)) as Record<string, unknown>;
  assertEquals(result.username, "alice");
  assertEquals(result.hobbies, ["coding", "music"]);
});

Deno.test("parseRequestBody - preserves inherited-name form keys and duplicates", async () => {
  const expected = Object.fromEntries([
    ["constructor", ["one", "two"]],
    ["__proto__", ["one", "two"]],
    ["toString", "one"],
  ]);
  const urlEncoded = new Request("http://test/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "constructor=one&constructor=two&__proto__=one&__proto__=two&toString=one",
  });
  assertEquals(await parseRequestBody(urlEncoded), expected);

  const formData = new FormData();
  formData.append("constructor", "one");
  formData.append("constructor", "two");
  formData.append("__proto__", "one");
  formData.append("__proto__", "two");
  formData.append("toString", "one");
  const multipart = new Request("http://test/", { method: "POST", body: formData });
  assertEquals(await parseRequestBody(multipart), expected);
});

Deno.test("parseRequestBody - treats a missing content type as JSON", async () => {
  const jsonReq = new Request("http://test/", {
    method: "POST",
    body: new TextEncoder().encode(JSON.stringify({ name: "Ada" })),
  });
  assertEquals(await parseRequestBody(jsonReq), { name: "Ada" });
});

Deno.test("parseRequestBody - rejects unsupported media types", async () => {
  const textReq = new Request("http://test/", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "plain text payload",
  });
  await assertRejects(
    () => parseRequestBody(textReq),
    AppError,
    "The request body media type is not supported.",
  );
});
