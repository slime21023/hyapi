import { openapi } from "@elysia/openapi";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { AnyElysia } from "elysia";
import type { ModuleDefinition, OpenApiOptions, Schema } from "./contract.ts";

/** Register JSON documentation for routes already compiled onto this application. */
export function installOpenApi(
  app: AnyElysia,
  options: OpenApiOptions,
  modules: readonly ModuleDefinition[],
): void {
  const converted = new Map<Schema, object>();
  const convertValibot = (schema: Schema): object =>
    toJsonSchema(schema as Parameters<typeof toJsonSchema>[0], {
      target: "draft-2020-12",
      errorMode: "throw",
    });
  const convert = (schema: Schema): object => {
    const cached = converted.get(schema);
    if (cached) return cached;

    const vendor = schema["~standard"].vendor;
    const converter =
      vendor === "valibot"
        ? convertValibot
        : Object.hasOwn(options.converters ?? {}, vendor)
          ? options.converters?.[vendor]
          : undefined;
    if (!converter) throw new Error(`No OpenAPI JSON Schema converter for vendor "${vendor}"`);

    const jsonSchema = converter(schema);
    if (!jsonSchema || typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
      throw new Error(
        `OpenAPI converter for vendor "${vendor}" did not return a JSON Schema object`,
      );
    }
    converted.set(schema, jsonSchema);
    return jsonSchema;
  };

  for (const module of modules) {
    if (
      module.authenticate &&
      (!module.security ||
        !Object.hasOwn(options.securitySchemes ?? {}, module.security) ||
        !options.securitySchemes?.[module.security])
    ) {
      throw new Error(`Protected module "${module.name}" needs a declared OpenAPI security scheme`);
    }
    for (const route of module.routes) {
      const { params, query, body, response } = route.options;
      for (const schema of [params, query, body]) {
        if (schema) convert(schema);
      }
      if (response) {
        if ("~standard" in response) {
          convert(response);
        } else {
          for (const schema of Object.values(response)) convert(schema);
        }
      }
    }
  }

  const mapJsonSchema: Record<string, (schema: Schema) => object> = Object.create(null);
  mapJsonSchema.valibot = convert;
  for (const vendor of Object.keys(options.converters ?? {})) {
    if (vendor !== "valibot") mapJsonSchema[vendor] = convert;
  }

  app.use(
    openapi({
      path: options.path,
      specPath: `${options.path}/json`,
      provider: null,
      exclude: { staticFile: false },
      documentation: {
        info: options.info,
        components: { securitySchemes: options.securitySchemes },
      } as NonNullable<NonNullable<Parameters<typeof openapi>[0]>["documentation"]>,
      mapJsonSchema,
    }),
  );
}
