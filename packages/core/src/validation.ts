import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { Schema } from "./types.ts";
import { ResponseValidationError, ValidationError } from "./errors.ts";

export type ValidationSource = "params" | "query" | "body" | "headers" | "response";

export class SchemaValidator {
  private readonly ajv: Ajv;
  private readonly validators = new WeakMap<object, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      coerceTypes: "array",
      strict: true,
      useDefaults: true,
    });
    this.ajv.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    this.ajv.addFormat(
      "uuid",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    this.ajv.addFormat("date-time", {
      type: "string",
      validate: (value: string) => value.includes("T") && !Number.isNaN(Date.parse(value)),
    });
  }

  validate<T>(schema: Schema, value: T, source: ValidationSource): T {
    const validator = this.compile(schema);
    if (validator(value)) return value;
    if (source === "response") {
      throw new ResponseValidationError(this.errors(validator.errors));
    }
    throw new ValidationError(source, this.errors(validator.errors));
  }

  toJsonSchema(schema: Schema): Record<string, unknown> {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  }

  private compile(schema: Schema): ValidateFunction {
    const cached = this.validators.get(schema);
    if (cached) return cached;
    const validator = this.ajv.compile(schema);
    this.validators.set(schema, validator);
    return validator;
  }

  private errors(errors: ErrorObject[] | null | undefined): readonly Record<string, unknown>[] {
    return (errors ?? []).map((error) => ({
      keyword: error.keyword,
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      params: error.params,
      message: error.message,
    }));
  }
}

export function queryObject(request: Request): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    const current = result[key];
    if (current === undefined) result[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else result[key] = [current, value];
  }
  return result;
}

export function headerObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

export async function jsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const contentLength = request.headers.get("content-length");
  if (contentLength === "0") return undefined;
  return await request.clone().json();
}
