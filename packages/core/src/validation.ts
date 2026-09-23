import "typebox/format";
import { Compile, type Validator } from "typebox/compile";
import { Value } from "typebox/value";
import { DEFAULT_BODY_LIMIT_BYTES, type Schema } from "./types.ts";
import { AppError, ResponseValidationError, ValidationError } from "./errors.ts";

export type ValidationSource = "params" | "query" | "body" | "headers" | "response";

export class SchemaValidator {
  private readonly validators = new WeakMap<object, Validator>();

  validate<T>(schema: Schema, value: unknown, source: ValidationSource): T {
    let targetValue = value;
    if (source === "response") {
      targetValue = Value.Clean(schema, Value.Clone(value));
    } else {
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

export async function parseRequestBody(
  request: Request,
  limitBytes = DEFAULT_BODY_LIMIT_BYTES,
): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (request.body === null) return undefined;

  const contentType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
  const isJson = !contentType || contentType === "application/json" ||
    /^application\/[\w.!#$&^-]+\+json$/.test(contentType);
  const isFormUrlEncoded = contentType === "application/x-www-form-urlencoded";
  const isMultipart = contentType === "multipart/form-data";

  if (!isJson && !isFormUrlEncoded && !isMultipart) {
    throw new AppError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request body media type is not supported.",
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > limitBytes) {
    throw new AppError(
      413,
      "PAYLOAD_TOO_LARGE",
      `Request body exceeds the ${limitBytes}-byte limit.`,
    );
  }

  const bytes = await readLimited(request.clone().body!, limitBytes);

  if (isJson) {
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError(400, "INVALID_JSON", "Request body is not valid JSON.");
    }
  }

  if (isFormUrlEncoded) {
    const text = new TextDecoder().decode(bytes);
    if (!text) return undefined;
    return entriesToObject(new URLSearchParams(text).entries());
  }

  // The media type guard above leaves multipart/form-data as the only remaining supported format.
  try {
    const formData = await new Response(bytes, {
      headers: { "content-type": request.headers.get("content-type")! },
    }).formData();
    return entriesToObject(formData.entries());
  } catch {
    throw new AppError(400, "INVALID_MULTIPART_DATA", "Failed to parse multipart form data.");
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  limitBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw new AppError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Request body exceeds the ${limitBytes}-byte limit.`,
      );
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
