import "typebox/format";
import { Compile, type Validator } from "typebox/compile";
import { Value } from "typebox/value";
import type { Schema } from "./types.ts";

export interface SchemaValidationIssue {
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly params: unknown;
  readonly message: string;
}

export class SchemaValidationError extends Error {
  constructor(readonly issues: readonly SchemaValidationIssue[]) {
    super("Schema validation failed.");
    this.name = "SchemaValidationError";
  }
}

export function objectSchemaProperties(schema: Schema): Record<string, Schema> | undefined {
  if (!("type" in schema) || schema.type !== "object" || !("properties" in schema)) {
    return undefined;
  }
  const properties = schema.properties;
  return properties !== null && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, Schema>
    : undefined;
}

/** Compiles schemas once and validates generic input and output values. */
export class SchemaValidator {
  private readonly validators = new WeakMap<object, Validator>();

  validateInput<T>(schema: Schema, value: unknown): T {
    let target = value;
    try {
      target = Value.Convert(schema, Value.Default(schema, value));
    } catch {
      // Conversion is optional; the compiled validator reports the actual schema mismatch.
    }
    return this.#validate(schema, target);
  }

  validateOutput<T>(schema: Schema, value: unknown): T {
    return this.#validate(schema, Value.Clean(schema, Value.Clone(value)));
  }

  toJsonSchema(schema: Schema): Record<string, unknown> {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  }

  #validate<T>(schema: Schema, value: unknown): T {
    const validator = this.#compile(schema);
    if (validator.Check(value)) return value as T;
    throw new SchemaValidationError(
      [...validator.Errors(value)].map((error) => ({
        keyword: error.keyword,
        instancePath: error.instancePath,
        schemaPath: error.schemaPath,
        params: error.params,
        message: error.message,
      })),
    );
  }

  #compile(schema: Schema): Validator {
    const cached = this.validators.get(schema);
    if (cached) return cached;
    const validator = Compile(schema);
    this.validators.set(schema, validator);
    return validator;
  }
}
