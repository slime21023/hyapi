import { type AnyRouteDefinition, isProtectedAuth, type OpenApiOptions } from "./types.ts";
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
    const status = route.responseStatus ?? 200;
    const isNoContent = status === 204;
    const { operationId, summary, description, tags, deprecated } = route.metadata ?? {};

    const operation: OpenApiOperation = {
      ...(operationId ? { operationId } : {}),
      ...(summary ? { summary } : {}),
      ...(description ? { description } : {}),
      ...(tags ? { tags } : {}),
      ...(deprecated !== undefined ? { deprecated } : {}),
      responses: {
        [String(status)]: {
          description: isNoContent ? "No content" : "Successful response",
          ...(route.response && !isNoContent
            ? {
              content: {
                "application/json": { schema: schemaValidator.toJsonSchema(route.response) },
              },
            }
            : {}),
        },
      },
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
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.request?.body) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: schemaValidator.toJsonSchema(route.request.body) },
        },
      };
    }
    if (isProtectedAuth(route.auth)) {
      operation.security = [{ bearerAuth: [] }];
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
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  };
}
