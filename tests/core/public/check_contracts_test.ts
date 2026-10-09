import { assert, assertEquals } from "@std/assert";
import Type from "typebox";
import {
  type Api,
  apiKey,
  checkContracts,
  type CheckResult,
  defineApi,
  defineContract,
  defineResponse,
  defineSchema,
  defineSecurity,
  type DiagnosticCode,
  httpBearer,
  oauth2,
} from "@hyapi/core/contract";

const T = Type;
const Ok = defineSchema("Ok", T.Object({ ok: T.Boolean() }));
const info = { title: "Test", version: "1.0.0" };

/** Builds an API from untyped operations, so diagnostics can be tested past the type checks. */
function apiOf(operations: Record<string, unknown>, options: Record<string, unknown> = {}): Api {
  const { contract = {}, ...rest } = options as { contract?: Record<string, unknown> };
  return defineApi({
    info,
    ...rest,
    contracts: [defineContract({ ...contract, operations } as never)],
  } as never) as Api;
}

function op(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { method: "GET", path: "/x", responses: { 200: Ok }, ...extra };
}

function codes(result: CheckResult): DiagnosticCode[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function expectError(result: CheckResult, code: DiagnosticCode): void {
  assert(!result.ok, `expected '${code}' to fail the check`);
  const found = result.diagnostics.find((diagnostic) => diagnostic.code === code);
  assert(found, `expected '${code}', got ${JSON.stringify(codes(result))}`);
  assertEquals(found.severity, "error");
}

function expectWarning(result: CheckResult, code: DiagnosticCode): void {
  assert(result.ok, `warnings must not fail the check: ${JSON.stringify(result.diagnostics)}`);
  assertEquals(
    result.diagnostics.find((d) => d.code === code)?.severity,
    "warning",
    JSON.stringify(result.diagnostics),
  );
}

Deno.test("structurally identical schemas may share a name", () => {
  const first = defineSchema("Same", T.Object({ a: T.String() }));
  const second = defineSchema("Same", T.Object({ a: T.String() }));
  const result = checkContracts(apiOf({
    a: op({ path: "/a", responses: { 200: first } }),
    b: op({ path: "/b", responses: { 200: second } }),
  }));
  assert(result.ok, JSON.stringify(result.diagnostics));
});

Deno.test("every problem is reported together", () => {
  const result = checkContracts(apiOf({
    a: op({ method: "FETCH", path: "no-slash" }),
    b: op({ path: "/b", responses: {} }),
  }));
  assertEquals(codes(result).sort(), ["invalid-method", "invalid-path", "no-responses"]);
});

// --- One test per diagnostic ---------------------------------------------------------------------

Deno.test("invalid-api", () => {
  expectError(checkContracts({} as never), "invalid-api");
  expectError(
    checkContracts(defineApi({ info: { title: "", version: "1" }, contracts: [] })),
    "invalid-api",
  );
  expectError(
    checkContracts(defineApi({ info, contracts: [{ operations: {} }] } as never) as Api),
    "invalid-api",
  );
});

Deno.test("duplicate-contract", () => {
  const contract = defineContract({
    operations: { a: { method: "GET", path: "/a", responses: { 200: Ok } } },
  });
  expectError(
    checkContracts(defineApi({ info, contracts: [contract, contract] })),
    "duplicate-contract",
  );
});

Deno.test("invalid-security-scheme", () => {
  const bad = (schemes: Record<string, unknown>) =>
    checkContracts(apiOf({ a: op() }, { securitySchemes: defineSecurity(schemes as never) }));
  expectError(bad({ key: apiKey({ in: "header", name: "" }) }), "invalid-security-scheme");
  expectError(bad({ oauth: oauth2({ flows: {} }) }), "invalid-security-scheme");
  expectError(
    bad({ oauth: oauth2({ flows: { clientCredentials: { scopes: {} } } }) }),
    "invalid-security-scheme",
  );
});

Deno.test("security-schemes-mismatch", () => {
  const apiSchemes = defineSecurity({ bearer: httpBearer() });
  const otherSchemes = defineSecurity({ bearer: httpBearer() });
  expectError(
    checkContracts(
      apiOf({ a: op() }, {
        securitySchemes: apiSchemes,
        contract: { securitySchemes: otherSchemes },
      }),
    ),
    "security-schemes-mismatch",
  );
});

Deno.test("unknown-security-scheme", () => {
  const schemes = defineSecurity({ bearer: httpBearer() });
  expectError(
    checkContracts(apiOf({ a: op({ security: [{ beare: [] }] }) }, { securitySchemes: schemes })),
    "unknown-security-scheme",
  );
});

Deno.test("undeclared-scope", () => {
  const schemes = defineSecurity({
    oauth: oauth2({
      flows: {
        clientCredentials: { tokenUrl: "https://auth.example/token", scopes: { "a:read": "Read" } },
      },
    }),
  });
  const check = (scopes: string[]) =>
    checkContracts(
      apiOf({ a: op({ security: [{ oauth: scopes }] }) }, { securitySchemes: schemes }),
    );
  assert(check(["a:read"]).ok);
  expectError(check(["a:write"]), "undeclared-scope");
});

Deno.test("empty-security-requirement", () => {
  expectError(checkContracts(apiOf({ a: op({ security: [{}] }) })), "empty-security-requirement");
});

Deno.test("duplicate-operation-id", () => {
  const one = defineContract({
    operations: { a: { method: "GET", path: "/one", responses: { 200: Ok } } },
  });
  const two = defineContract({
    operations: { a: { method: "GET", path: "/two", responses: { 200: Ok } } },
  });
  expectError(checkContracts(defineApi({ info, contracts: [one, two] })), "duplicate-operation-id");
});

Deno.test("duplicate-route", () => {
  expectError(
    checkContracts(apiOf({
      a: op({ path: "/users/{id}", params: T.Object({ id: T.String() }) }),
      b: op({ path: "/users/{name}", params: T.Object({ name: T.String() }) }),
    })),
    "duplicate-route",
  );
  assert(
    checkContracts(apiOf({
      a: op({ path: "/users/{id}", params: T.Object({ id: T.String() }) }),
      b: op({ path: "/users/me" }),
    })).ok,
  );
});

Deno.test("invalid-method", () => {
  expectError(checkContracts(apiOf({ a: op({ method: "FETCH" }) })), "invalid-method");
});

Deno.test("invalid-path", () => {
  for (const path of ["users", "/a/{b", "/a/{b}/{b}", "/a/{1b}", "/a?x=1"]) {
    expectError(checkContracts(apiOf({ a: op({ path }) })), "invalid-path");
  }
});

Deno.test("path-parameter-mismatch", () => {
  expectError(checkContracts(apiOf({ a: op({ path: "/a/{id}" }) })), "path-parameter-mismatch");
  expectError(
    checkContracts(apiOf({ a: op({ path: "/a", params: T.Object({ id: T.String() }) }) })),
    "path-parameter-mismatch",
  );
});

Deno.test("optional-path-parameter", () => {
  expectError(
    checkContracts(
      apiOf({ a: op({ path: "/a/{id}", params: T.Object({ id: T.Optional(T.String()) }) }) }),
    ),
    "optional-path-parameter",
  );
});

Deno.test("invalid-parameter-schema", () => {
  expectError(checkContracts(apiOf({ a: op({ query: T.String() }) })), "invalid-parameter-schema");
});

Deno.test("unsupported-parameter-style", () => {
  const query = T.Object({ ids: T.Array(T.String()), filter: T.Object({ a: T.String() }) });
  expectError(
    checkContracts(
      apiOf({ a: op({ query, styles: { query: { ids: { style: "pipeDelimited" } } } }) }),
    ),
    "unsupported-parameter-style",
  );
  expectError(
    checkContracts(
      apiOf({ a: op({ query, styles: { query: { ids: { style: "deepObject" } } } }) }),
    ),
    "unsupported-parameter-style",
  );
  expectError(
    checkContracts(
      apiOf({
        a: op({ query, styles: { query: { filter: { style: "deepObject", explode: false } } } }),
      }),
    ),
    "unsupported-parameter-style",
  );
});

Deno.test("unknown-style-target", () => {
  expectError(
    checkContracts(
      apiOf({ a: op({ query: T.Object({ q: T.String() }), styles: { query: { x: {} } } }) }),
    ),
    "unknown-style-target",
  );
  expectError(
    checkContracts(apiOf({ a: op({ styles: { cookies: { s: {} } } }) })),
    "unknown-style-target",
  );
});

Deno.test("duplicate-header", () => {
  expectError(
    checkContracts(
      apiOf({ a: op({ headers: T.Object({ "X-Id": T.String(), "x-id": T.String() }) }) }),
    ),
    "duplicate-header",
  );
});

Deno.test("reserved-header", () => {
  expectError(
    checkContracts(apiOf({ a: op({ headers: T.Object({ Authorization: T.String() }) }) })),
    "reserved-header",
  );
});

Deno.test("invalid-body", () => {
  expectError(
    checkContracts(apiOf({ a: op({ method: "POST", body: { foo: 1 } }) })),
    "invalid-body",
  );
});

Deno.test("body-on-safe-method", () => {
  expectWarning(checkContracts(apiOf({ a: op({ body: Ok }) })), "body-on-safe-method");
});

Deno.test("invalid-media-type", () => {
  expectError(
    checkContracts(apiOf({ a: op({ method: "POST", body: { schema: Ok, mediaType: "json" } }) })),
    "invalid-media-type",
  );
});

Deno.test("no-responses", () => {
  expectError(checkContracts(apiOf({ a: op({ responses: {} }) })), "no-responses");
});

Deno.test("invalid-status", () => {
  expectError(checkContracts(apiOf({ a: op({ responses: { 999: Ok } }) })), "invalid-status");
  expectError(checkContracts(apiOf({ a: op({ responses: { "2XX": Ok } }) })), "invalid-status");
});

Deno.test("invalid-response", () => {
  expectError(checkContracts(apiOf({ a: op({ responses: { 200: 42 } }) })), "invalid-response");
});

Deno.test("body-not-allowed", () => {
  expectError(
    checkContracts(apiOf({ a: op({ responses: { 204: { description: "None", body: Ok } } }) })),
    "body-not-allowed",
  );
});

Deno.test("unsupported-schema", () => {
  const codec = T.Codec(T.String()).Decode((value) => value).Encode((value) => value);
  const refine = T.Refine(T.String(), (value) => value.length > 0);
  for (const schema of [codec, refine, T.Function([], T.String()), T.Undefined(), T.BigInt()]) {
    expectError(
      checkContracts(
        apiOf({ a: op({ responses: { 200: defineSchema("Bad", T.Object({ value: schema })) } }) }),
      ),
      "unsupported-schema",
    );
  }
});

Deno.test("unresolved-reference", () => {
  expectError(
    checkContracts(
      apiOf({
        a: op({ responses: { 200: defineSchema("R", T.Object({ x: T.Ref("Missing") })) } }),
      }),
    ),
    "unresolved-reference",
  );
  const Node = T.Cyclic({ Node: T.Object({ next: T.Optional(T.Ref("Node")) }) }, "Node");
  assert(checkContracts(apiOf({ a: op({ responses: { 200: defineSchema("Node", Node) } }) })).ok);
});

Deno.test("invalid-component-name", () => {
  expectError(
    checkContracts(
      apiOf({ a: op({ responses: { 200: defineSchema("User Name", T.Object({})) } }) }),
    ),
    "invalid-component-name",
  );
  expectError(
    checkContracts(
      apiOf({ a: op({ responses: { 404: defineResponse("Not Found", { description: "x" }) } }) }),
    ),
    "invalid-component-name",
  );
});

Deno.test("duplicate-schema-name", () => {
  const first = defineSchema("User", T.Object({ a: T.String() }));
  const second = defineSchema("User", T.Object({ b: T.String() }));
  expectError(
    checkContracts(apiOf({
      a: op({ path: "/a", responses: { 200: first } }),
      b: op({ path: "/b", responses: { 200: second } }),
    })),
    "duplicate-schema-name",
  );
});

Deno.test("duplicate-response-name", () => {
  const first = defineResponse("Gone", { description: "Gone" });
  const second = defineResponse("Gone", { description: "Gone again" });
  expectError(
    checkContracts(apiOf({
      a: op({ path: "/a", responses: { 410: first } }),
      b: op({ path: "/b", responses: { 410: second } }),
    })),
    "duplicate-response-name",
  );
});

Deno.test("unknown-format", () => {
  const withFormat = (format: string, formats?: Record<string, unknown>) =>
    checkContracts(
      apiOf({
        a: op({ responses: { 200: defineSchema("F", T.Object({ v: T.String({ format }) })) } }),
      }, formats === undefined ? {} : { formats }),
    );
  expectError(withFormat("made-up"), "unknown-format");
  assert(withFormat("email").ok);
  assert(withFormat("int64").ok);
  assert(withFormat("made-up", { "made-up": () => true }).ok);
});

Deno.test("formats registered elsewhere in the process do not change the result", async () => {
  const Format = await import("typebox/format");
  const api = apiOf({
    a: op({
      responses: { 200: defineSchema("F", T.Object({ v: T.String({ format: "elsewhere" }) })) },
    }),
  });
  expectError(checkContracts(api), "unknown-format");
  Format.Set("elsewhere", () => true);
  expectError(checkContracts(api), "unknown-format");
});

Deno.test("invalid-format", () => {
  const withFormats = (formats: Record<string, unknown>) =>
    checkContracts(apiOf({ a: op() }, { formats }));
  expectError(withFormats({ email: () => true }), "invalid-format");
  expectError(withFormats({ int32: () => true }), "invalid-format");
  expectError(withFormats({ isbn: "not a function" }), "invalid-format");
  assert(withFormats({ isbn: () => true }).ok);
});

Deno.test("checkContracts returns diagnostics only", () => {
  assertEquals(Object.keys(checkContracts(apiOf({ a: op() }))).sort(), ["diagnostics", "ok"]);
});

Deno.test("unnamed-schema", () => {
  expectWarning(
    checkContracts(apiOf({ a: op({ responses: { 200: T.Object({ inline: T.String() }) } }) })),
    "unnamed-schema",
  );
  const result = checkContracts(apiOf({ a: op({ responses: { 200: T.Array(Ok) } }) }));
  assert(result.ok && result.diagnostics.length === 0, JSON.stringify(result.diagnostics));
});
