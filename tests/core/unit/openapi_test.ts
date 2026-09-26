import { assert, assertEquals } from "@std/assert";
import Type from "typebox";
import { buildOpenApiDocument } from "../../../packages/core/src/openapi.ts";
import { SchemaValidator } from "../../../packages/core/src/schema.ts";
import type { AnyRouteDefinition } from "@hyapi/core";

Deno.test("OpenAPI - builds standard OpenAPI 3.1 document with ProblemDetails component", () => {
  const validator = new SchemaValidator();
  const routes: AnyRouteDefinition[] = [];

  const doc = buildOpenApiDocument(routes, validator, {
    title: "Test API",
    version: "1.2.3",
    description: "API Desc",
  }) as any;

  assertEquals(doc.openapi, "3.1.0");
  assertEquals(doc.info.title, "Test API");
  assertEquals(doc.info.version, "1.2.3");
  assertEquals(doc.info.description, "API Desc");

  const components = doc.components as Record<string, unknown>;
  const schemas = components.schemas as Record<string, unknown>;
  const securitySchemes = components.securitySchemes as Record<string, unknown>;

  assert(schemas.ProblemDetails);
  assert(securitySchemes.bearerAuth);
});

Deno.test("OpenAPI - maps query, params, headers, and body with auto-injected 400 response", () => {
  const validator = new SchemaValidator();
  const routes: AnyRouteDefinition[] = [
    {
      method: "post",
      path: "/items/{id}",
      request: {
        params: Type.Object({ id: Type.String() }),
        query: Type.Object({ filter: Type.Optional(Type.String()) }),
        headers: Type.Object({ "x-version": Type.String() }),
        body: Type.Object({ name: Type.String() }),
      },
      responses: {
        201: Type.Object({ id: Type.String(), name: Type.String() }),
      },
      metadata: {
        operationId: "createItem",
        summary: "Create an item",
        tags: ["items"],
      },
      handler: () => undefined,
    },
  ];

  const doc = buildOpenApiDocument(routes, validator, {
    title: "Test",
    version: "1.0.0",
  }) as any;

  const paths = doc.paths as Record<string, Record<string, any>>;
  const operation = paths["/items/{id}"]?.post;
  assert(operation);

  assertEquals(operation.operationId, "createItem");
  assertEquals(operation.summary, "Create an item");
  assertEquals(operation.tags, ["items"]);

  // Parameters
  assertEquals(operation.parameters.length, 3); // path, query, header
  assert(operation.parameters.some((p: any) => p.in === "path" && p.name === "id"));
  assert(operation.parameters.some((p: any) => p.in === "query" && p.name === "filter"));
  assert(operation.parameters.some((p: any) => p.in === "header" && p.name === "x-version"));

  // Request Body
  assert(operation.requestBody.content["application/json"]);
  assert(operation.requestBody.content["application/x-www-form-urlencoded"]);
  assert(operation.requestBody.content["multipart/form-data"]);
  assertEquals(operation.requestBody.required, true);

  // Responses (201 declared + 400 auto-injected)
  assert(operation.responses["201"]);
  assert(operation.responses["400"]);
});

Deno.test("OpenAPI - maps security scopes and optional auth with 401/403 responses", () => {
  const validator = new SchemaValidator();
  const routes: AnyRouteDefinition[] = [
    {
      method: "get",
      path: "/protected",
      auth: { scopes: ["admin", "superadmin"] },
      responses: { 200: Type.Object({ secret: Type.String() }) },
      handler: () => undefined,
    },
    {
      method: "get",
      path: "/optional-auth",
      auth: { required: false },
      responses: { 200: Type.Object({ public: Type.Boolean() }) },
      handler: () => undefined,
    },
    {
      method: "get",
      path: "/public",
      responses: { 200: Type.Object({ ok: Type.Boolean() }) },
      handler: () => undefined,
    },
    {
      method: "post",
      path: "/optional-body",
      request: {
        body: Type.Object({ name: Type.String() }),
        bodyRequired: false,
      },
      responses: { 200: Type.Object({ accepted: Type.Boolean() }) },
      handler: () => undefined,
    },
  ];

  const doc = buildOpenApiDocument(routes, validator, {
    title: "Test",
    version: "1.0.0",
  }) as any;

  const paths = doc.paths as Record<string, Record<string, any>>;

  // Protected route
  const protectedOp = paths["/protected"]?.get;
  assert(protectedOp);
  assertEquals(protectedOp.security, [{ bearerAuth: ["admin", "superadmin"] }]);
  assert(protectedOp.responses["401"]);
  assert(protectedOp.responses["403"]);

  // Optional auth route
  const optionalOp = paths["/optional-auth"]?.get;
  assert(optionalOp);
  assertEquals(optionalOp.security, [{ bearerAuth: [] }, {}]);
  assert(optionalOp.responses["401"]);

  // Public route
  const publicOp = paths["/public"]?.get;
  assert(publicOp);
  assertEquals(publicOp.security, undefined);
  assertEquals(publicOp.responses["401"], undefined);

  const optionalBodyOp = paths["/optional-body"]?.post;
  assert(optionalBodyOp);
  assertEquals(optionalBodyOp.requestBody.required, false);
  assert(optionalBodyOp.requestBody.content["application/json"]);
  assert(optionalBodyOp.requestBody.content["application/x-www-form-urlencoded"]);
  assert(optionalBodyOp.requestBody.content["multipart/form-data"]);
});

Deno.test("OpenAPI - documents 413 and 415 problems for routes with request bodies", () => {
  const validator = new SchemaValidator();
  const routes: AnyRouteDefinition[] = [
    {
      method: "post",
      path: "/items",
      request: { body: Type.Object({ name: Type.String() }) },
      responses: { 201: Type.Object({ id: Type.String() }) },
      handler: () => undefined,
    },
    {
      method: "get",
      path: "/items",
      responses: { 200: Type.Array(Type.Object({ id: Type.String() })) },
      handler: () => undefined,
    },
  ];

  const doc = buildOpenApiDocument(routes, validator, {
    title: "Test",
    version: "1.0.0",
  }) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };

  const problem = {
    content: {
      "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } },
    },
  };
  const create = doc.paths["/items"]?.post;
  assertEquals(create?.responses["413"], { description: "Payload too large", ...problem });
  assertEquals(create?.responses["415"], { description: "Unsupported media type", ...problem });
  const list = doc.paths["/items"]?.get;
  assert(list);
  assertEquals(list.responses["413"], undefined);
  assertEquals(list.responses["415"], undefined);
});

Deno.test("OpenAPI does not invent a problem-only body for an untyped failure fallback", () => {
  const document = buildOpenApiDocument(
    [{
      method: "get",
      path: "/fallback",
      responseStatus: 404,
      handler: () => ({ message: "missing" }),
    }],
    new SchemaValidator(),
    {
      title: "Test",
      version: "1.0.0",
    },
  ) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };

  const fallback = document.paths["/fallback"]?.get;
  assert(fallback);
  assertEquals(fallback.responses["404"], {
    description: "Status 404 response",
  });
});
