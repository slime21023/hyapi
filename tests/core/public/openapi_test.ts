import { assert, assertEquals, assertThrows } from "@std/assert";
import { Validator } from "@seriousme/openapi-schema-validator";
import Type from "typebox";
import { ContractError, defineApi, defineContract } from "@hyapi/core/contract";
import { emitOpenApi, serializeOpenApi } from "@hyapi/core/openapi";
import { api } from "../../fixtures/library_api.ts";

const golden = new URL("../../fixtures/library_api.openapi.json", import.meta.url);

// deno-lint-ignore no-explicit-any
const document = () => emitOpenApi(api) as any;

Deno.test("emission matches the committed golden document byte for byte", async () => {
  // The golden file is also checked by `deno fmt`, so the canonical text is formatter-stable.
  assertEquals(serializeOpenApi(emitOpenApi(api)), await Deno.readTextFile(golden));
});

Deno.test("emission is deterministic across runs", () => {
  assertEquals(serializeOpenApi(emitOpenApi(api)), serializeOpenApi(emitOpenApi(api)));
});

Deno.test("the emitted document is valid OpenAPI 3.1", async () => {
  const validator = new Validator();
  const result = await validator.validate(document());
  assertEquals(result, { valid: true });
  assertEquals(document().openapi, "3.1.1");
});

Deno.test("named schemas become component references, including inside derived schemas", () => {
  const doc = document();
  assertEquals(Object.keys(doc.components.schemas), [
    "BookList",
    "Book",
    "Author",
    "Problem",
    "CreateBook",
  ]);
  assertEquals(doc.components.schemas.BookList.properties.items.items, {
    $ref: "#/components/schemas/Book",
  });
  // T.Omit copies nested schemas; their names survive the copy.
  assertEquals(doc.components.schemas.CreateBook.properties.authors.items, {
    $ref: "#/components/schemas/Author",
  });
  // A component's own definition is never a reference to itself.
  assertEquals(doc.components.schemas.Book.type, "object");
});

Deno.test("hidden TypeBox markers never reach the document", () => {
  const text = serializeOpenApi(emitOpenApi(api));
  assert(!text.includes("~kind") && !text.includes("~optional") && !text.includes("~hyapi"));
});

Deno.test("security follows the effective requirement of each operation", () => {
  const { paths, security } = document();
  assertEquals(security, [{ key: [] }], "the API root requirement");
  assertEquals(
    paths["/books"].get.security,
    [{ bearer: [] }, { oauth: ["books:read"] }],
    "contract default",
  );
  assertEquals(paths["/books"].post.security, [{ oauth: ["books:write"] }], "operation override");
  assertEquals(paths["/health"].get.security, [], "public operation");
  assertEquals(paths["/export"].get.security, undefined, "inherits the root in OpenAPI");
});

Deno.test("parameters, bodies, and responses carry their declared details", () => {
  const { paths, components } = document();
  const [limit, ids, filter] = paths["/books"].get.parameters;
  assertEquals([limit.in, limit.style, limit.schema.default], ["query", undefined, 20]);
  assertEquals([ids.explode, ids.description], [false, "Filter by id"]);
  assertEquals(filter.style, "deepObject");
  assertEquals(paths["/books/{id}"].get.parameters[0].required, true);
  assertEquals(paths["/books"].post.requestBody.required, true);
  assertEquals(paths["/books"].post.responses["201"].headers.location.required, true);
  assertEquals(paths["/books/{id}"].get.responses["404"], {
    $ref: "#/components/responses/NotFound",
  });
  assertEquals(Object.keys(components.responses.NotFound.content), ["application/problem+json"]);
  assertEquals(Object.keys(paths["/export"].get.responses["200"].content), ["text/csv"]);
  assertEquals(paths["/books/{id}"].delete.deprecated, true);
});

Deno.test("contracts with errors throw a ContractError with every diagnostic", () => {
  const broken = defineApi({
    info: { title: "Broken", version: "1" },
    contracts: [
      defineContract({
        operations: {
          a: { method: "GET", path: "/a/{id}", responses: { 200: Type.Object({}) } },
        } as never,
      }),
    ],
  });
  const error = assertThrows(() => emitOpenApi(broken), ContractError);
  assert(error.diagnostics.some((d) => d.code === "path-parameter-mismatch"));
  assert(error.message.includes("[path-parameter-mismatch] a:"));
});
