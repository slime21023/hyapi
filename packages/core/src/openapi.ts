/** Defines OpenAPI documents and their application-level configuration. @module */

import { type AnyRouteDefinition } from "./types.ts";
import type { SchemaValidator } from "./schema.ts";
import { resolveResponseSchemas } from "./routing.ts";
import { ConfigurationError } from "./errors.ts";
import type { Guard } from "./guards.ts";

/** Fully resolved OpenAPI document served by the application. */
export interface OpenApiDocument {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly version: string;
  readonly path: string;
}

/** User-provided values for one named OpenAPI document. */
export interface OpenApiDocumentOptions {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly version?: string;
  readonly path: string;
}

/** Normalized set of OpenAPI documents exposed by an application. */
export interface OpenApiConfig {
  readonly enabled: boolean;
  readonly defaultDocument: string;
  readonly documents: readonly OpenApiDocument[];
}

/** Optional OpenAPI configuration accepted by {@link defineConfig}. */
export interface OpenApiConfigOptions {
  readonly enabled?: boolean;
  readonly defaultDocument?: string;
  readonly documents?: readonly OpenApiDocumentOptions[];
}

export function selectOpenApiRoutes(
  routes: readonly AnyRouteDefinition[],
  documentId: string,
  defaultDocument: string,
): AnyRouteDefinition[] {
  return routes.filter((route) => {
    const documentIds = route.metadata?.documentIds;
    return documentIds === undefined
      ? documentId === defaultDocument
      : documentIds.includes(documentId);
  });
}

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

/** One way to satisfy a guard chain: the schemes it presents and the scopes it must hold. */
interface SecurityOption {
  readonly schemes: readonly string[];
  readonly scopes: readonly string[];
  /** Some guard admits requests without credentials. */
  readonly optional: boolean;
  /** Some guard requires an identity (it declares scopes, possibly none). */
  readonly requiresIdentity: boolean;
  /** Some guard has no security metadata and may reject for its own reasons. */
  readonly opaque: boolean;
}

function guardOptions(guard: Guard): SecurityOption[] {
  const security = guard.security;
  if (security?.alternatives) return security.alternatives.flatMap(guardOptions);
  return [{
    schemes: Object.keys(security?.schemes ?? {}),
    scopes: security?.scopes ?? [],
    optional: security?.optional ?? false,
    requiresIdentity: security?.scopes !== undefined,
    opaque: security === undefined,
  }];
}

/** Every combination of each guard's alternatives, merged along the chain. */
function chainOptions(guards: readonly Guard[]): SecurityOption[] {
  let options: SecurityOption[] = [{
    schemes: [],
    scopes: [],
    optional: false,
    requiresIdentity: false,
    opaque: false,
  }];
  for (const guard of guards) {
    const next = guardOptions(guard);
    options = options.flatMap((option) =>
      next.map((choice) => ({
        schemes: [...new Set([...option.schemes, ...choice.schemes])],
        scopes: [...new Set([...option.scopes, ...choice.scopes])],
        optional: option.optional || choice.optional,
        requiresIdentity: option.requiresIdentity || choice.requiresIdentity,
        opaque: option.opaque || choice.opaque,
      }))
    );
  }
  return options;
}

function collectSecuritySchemes(
  guards: readonly Guard[],
  schemes: Map<string, Readonly<Record<string, unknown>>>,
): void {
  for (const guard of guards) {
    for (const [name, scheme] of Object.entries(guard.security?.schemes ?? {})) {
      const previous = schemes.get(name);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(scheme)) {
        throw new ConfigurationError(
          `OpenAPI security scheme '${name}' is declared with different definitions.`,
        );
      }
      schemes.set(name, scheme);
    }
    collectSecuritySchemes(guard.security?.alternatives ?? [], schemes);
  }
}

function securityRequirements(
  options: readonly SecurityOption[],
): Record<string, readonly string[]>[] {
  const requirements = new Map<string, Record<string, readonly string[]>>();
  for (const option of options) {
    if (option.schemes.length > 0) {
      const requirement = Object.fromEntries(
        option.schemes.map((scheme) => [scheme, option.scopes]),
      );
      requirements.set(JSON.stringify(requirement), requirement);
    }
    if (option.optional && !option.requiresIdentity) requirements.set("{}", {});
  }
  return [...requirements.values()];
}

export function buildOpenApiDocument(
  routes: readonly AnyRouteDefinition[],
  schemaValidator: SchemaValidator,
  document: Pick<OpenApiDocument, "title" | "description" | "version">,
): Record<string, unknown> {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  const securitySchemes = new Map<string, Readonly<Record<string, unknown>>>();

  for (const route of routes) {
    const guards = route.guards ?? [];
    collectSecuritySchemes(guards, securitySchemes);
    const security = chainOptions(guards);
    const { operationId, summary, description, tags, deprecated } = route.metadata ?? {};
    const responses: Record<string, unknown> = {};

    const responseSchemas = resolveResponseSchemas(route);
    for (const [statusCode, schema] of Object.entries(responseSchemas)) {
      const statusNum = Number(statusCode);
      const isNoContent = statusNum === 204;
      const isFailure = route.responses !== undefined && statusNum >= 400 && statusNum <= 599;
      const content = !isNoContent && schema
        ? {
          "application/json": { schema: schemaValidator.toJsonSchema(schema) },
          ...(isFailure ? problemContent() : {}),
        }
        : isFailure
        ? problemContent()
        : undefined;
      responses[String(statusNum)] = {
        description: isNoContent ? "No content" : `Status ${statusNum} response`,
        ...(content ? { content } : {}),
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

    if (
      guards.length > 0 &&
      security.some((option) => option.schemes.length > 0 || option.requiresIdentity)
    ) {
      responses["401"] ??= problemResponse("Authentication required or invalid credentials");
    }
    if (security.some((option) => option.scopes.length > 0 || option.opaque)) {
      responses["403"] ??= problemResponse("Forbidden");
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

    const requirements = securityRequirements(security);
    if (requirements.some((requirement) => Object.keys(requirement).length > 0)) {
      operation.security = requirements;
    }

    const pathItem = paths[route.path] ?? {};
    pathItem[route.method] = operation;
    paths[route.path] = pathItem;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: document.title,
      ...(document.description === undefined ? {} : { description: document.description }),
      version: document.version,
    },
    paths,
    components: {
      ...(securitySchemes.size > 0 ? { securitySchemes: Object.fromEntries(securitySchemes) } : {}),
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

function problemContent(): Record<string, unknown> {
  return {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ProblemDetails" },
    },
  };
}

function problemResponse(description: string): Record<string, unknown> {
  return { description, content: problemContent() };
}
