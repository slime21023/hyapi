import "typebox/format";
import { Compile, type Validator } from "typebox/compile";
import { Value } from "typebox/value";
import type { Schema } from "./types.ts";
import { AppError, ResponseValidationError, ValidationError } from "./errors.ts";

export type ValidationSource = "params" | "query" | "body" | "headers" | "response";

export class SchemaValidator {
  private readonly validators = new WeakMap<object, Validator>();

  validate<T>(schema: Schema, value: unknown, source: ValidationSource): T {
    let targetValue = value;
    if (source !== "response") {
      try {
        targetValue = Value.Convert(schema, Value.Default(schema, value));
      } catch {
        targetValue = value;
      }
    }

    const validator = this.compile(schema);
    if (validator.Check(targetValue)) return targetValue as T;

    const errors = [...validator.Errors(targetValue)].map((error) => ({
      keyword: error.keyword,
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      params: error.params,
      message: error.message,
    }));

    if (source === "response") {
      throw new ResponseValidationError(errors);
    }
    throw new ValidationError(source, errors);
  }

  toJsonSchema(schema: Schema): Record<string, unknown> {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  }

  private compile(schema: Schema): Validator {
    const cached = this.validators.get(schema);
    if (cached) return cached;
    const validator = Compile(schema);
    this.validators.set(schema, validator);
    return validator;
  }
}

export function entriesToObject<T = unknown>(
  entries: Iterable<[string, T]>,
): Record<string, T | T[]> {
  const result: Record<string, T | T[]> = {};
  for (const [key, value] of entries) {
    const current = result[key];
    if (current === undefined) result[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else result[key] = [current, value];
  }
  return result;
}

export function queryObject(request: Request): Record<string, string | string[]> {
  return entriesToObject(new URL(request.url).searchParams.entries()) as Record<
    string,
    string | string[]
  >;
}

export function headerObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

export async function parseRequestBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;

  const contentType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
  const isJson = !contentType || contentType === "application/json";
  const isFormUrlEncoded = contentType === "application/x-www-form-urlencoded";
  const isMultipart = contentType === "multipart/form-data";

  if (!isJson && !isFormUrlEncoded && !isMultipart) {
    throw new AppError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request body media type is not supported.",
    );
  }

  if (request.body === null) return undefined;

  const source = request.clone();

  if (isJson) {
    const text = await source.text();
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError(400, "INVALID_JSON", "Request body is not valid JSON.");
    }
  }

  if (isFormUrlEncoded) {
    try {
      const text = await source.text();
      if (!text) return undefined;
      return entriesToObject(new URLSearchParams(text).entries());
    } catch {
      throw new AppError(400, "INVALID_FORM_DATA", "Failed to parse form URL-encoded body.");
    }
  }

  // The media type guard above leaves multipart/form-data as the only remaining supported format.
  try {
    const formData = await source.formData();
    return entriesToObject(formData.entries());
  } catch {
    throw new AppError(400, "INVALID_MULTIPART_DATA", "Failed to parse multipart form data.");
  }
}
