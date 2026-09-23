import {
  type AnyRouteDefinition,
  extractResponseSchemas,
  isProtectedAuth,
  type OpenApiOptions,
} from "./types.ts";
import type { SchemaValidator } from "./validation.ts";

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: readonly string[];
  deprecated?: boolean;
  parameters?: readonly Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  responses: Record<string, unknown>;
  security?: readonly Record<string, readonly string[]>[];
}

export function buildOpenApiDocument(
  routes: readonly AnyRouteDefinition[],
  schemaValidator: SchemaValidator,
  options: OpenApiOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (const route of routes) {
    const { operationId, summary, description, tags, deprecated } = route.metadata ?? {};
    const responses: Record<string, unknown> = {};

    const responseSchemas = extractResponseSchemas(route);
    for (const [statusCode, schema] of Object.entries(responseSchemas)) {
      const statusNum = Number(statusCode);
      const isNoContent = statusNum === 204;
      responses[String(statusNum)] = {
        description: isNoContent ? "No content" : `Status ${statusNum} response`,
        ...(!isNoContent && schema
          ? {
            content: {
              "application/json": { schema: schemaValidator.toJsonSchema(schema) },
            },
          }
          : {}),
      };
    }

    if (
      !responses["400"] &&
      (route.request?.params || route.request?.query || route.request?.body ||
        route.request?.headers)
    ) {
      responses["400"] = problemResponse("Bad request / validation failure");
    }

    if (route.request?.body) {
      responses["413"] ??= problemResponse("Payload too large");
      responses["415"] ??= problemResponse("Unsupported media type");
    }

    if (isProtectedAuth(route.auth)) {
      responses["401"] ??= problemResponse("Authentication required or invalid token");
      if (route.auth.scopes && route.auth.scopes.length > 0) {
        responses["403"] ??= problemResponse("Forbidden / insufficient scope");
      }
    }

    const operation: OpenApiOperation = {
      ...(operationId ? { operationId } : {}),
      ...(summary ? { summary } : {}),
      ...(description ? { description } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(deprecated !== undefined ? { deprecated } : {}),
      responses,
    };

    const parameters: Record<string, unknown>[] = [];
    const params = route.request?.params as Record<string, unknown> | undefined;
    const query = route.request?.query as Record<string, unknown> | undefined;
    const parameterNames = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    for (const name of parameterNames) {
      if (!name) continue;
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: params?.properties && typeof params.properties === "object"
          ? (params.properties as Record<string, unknown>)[name] ?? { type: "string" }
          : { type: "string" },
      });
    }
    if (query?.properties && typeof query.properties === "object") {
      const required = new Set(Array.isArray(query.required) ? query.required : []);
      for (const [name, schema] of Object.entries(query.properties as Record<string, unknown>)) {
        parameters.push({ name, in: "query", required: required.has(name), schema });
      }
    }
    const headers = route.request?.headers as Record<string, unknown> | undefined;
    if (headers?.properties && typeof headers.properties === "object") {
      const required = new Set(Array.isArray(headers.required) ? headers.required : []);
      for (const [name, schema] of Object.entries(headers.properties as Record<string, unknown>)) {
        parameters.push({ name, in: "header", required: required.has(name), schema });
      }
    }
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.request?.body) {
      operation.requestBody = {
        required: route.request.bodyRequired !== false,
        content: {
          "application/json": { schema: schemaValidator.toJsonSchema(route.request.body) },
          "application/x-www-form-urlencoded": {
            schema: schemaValidator.toJsonSchema(route.request.body),
          },
          "multipart/form-data": { schema: schemaValidator.toJsonSchema(route.request.body) },
        },
      };
    }

    if (isProtectedAuth(route.auth)) {
      const scopes = route.auth.scopes ? [...route.auth.scopes] : [];
      if (route.auth.required === false) {
        operation.security = [{ bearerAuth: scopes }, {}];
      } else {
        operation.security = [{ bearerAuth: scopes }];
      }
    }

    const pathItem = paths[route.path] ?? {};
    pathItem[route.method] = operation;
    paths[route.path] = pathItem;
  }

  return {
    openapi: "3.1.0",
    info: options.info,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JSON Web Token with optional permission scopes",
        },
      },
      schemas: {
        ProblemDetails: {
          type: "object",
          required: ["type", "title", "status", "detail", "instance", "code", "requestId"],
          properties: {
            type: { type: "string" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            instance: { type: "string" },
            code: { type: "string" },
            requestId: { type: "string" },
            details: {},
          },
        },
      },
    },
  };
}

function problemResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetails" },
      },
    },
  };
}
