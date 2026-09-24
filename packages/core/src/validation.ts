import "typebox/format";
import { Compile, type Validator } from "typebox/compile";
import { Value } from "typebox/value";
import type { Schema } from "./types.ts";
import { AppError, ResponseValidationError, ValidationError } from "./errors.ts";

export type ValidationSource = "params" | "query" | "body" | "headers" | "response";

export function objectSchemaProperties(schema: Schema): Record<string, Schema> | undefined {
  if (!("type" in schema) || schema.type !== "object" || !("properties" in schema)) {
    return undefined;
  }
  const properties = schema.properties;
  return properties !== null && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, Schema>
    : undefined;
}

const headerPropertyNames = new WeakMap<object, ReadonlyMap<string, string>>();

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
    if (!Object.hasOwn(result, key)) {
      Object.defineProperty(result, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      const current = result[key]!;
      if (Array.isArray(current)) current.push(value);
      else result[key] = [current, value];
    }
  }
  return result;
}

export function queryObject(request: Request): Record<string, string | string[]> {
  return entriesToObject(new URL(request.url).searchParams.entries()) as Record<
    string,
    string | string[]
  >;
}

export function headerObject(headers: Headers, schema?: Schema): Record<string, string> {
  const result: Record<string, string> = Object.fromEntries(headers.entries());
  if (!schema) return result;

  let names = headerPropertyNames.get(schema);
  if (!names) {
    const declared = new Map<string, string>();
    for (const name of Object.keys(objectSchemaProperties(schema) ?? {})) {
      if (name !== name.toLowerCase()) declared.set(name.toLowerCase(), name);
    }
    names = declared;
    headerPropertyNames.set(schema, names);
  }
  for (const [lower, declared] of names) {
    if (!Object.hasOwn(result, lower)) continue;
    result[declared] = result[lower]!;
    delete result[lower];
  }
  return result;
}

function payloadTooLarge(limitBytes: number): AppError {
  return new AppError(
    413,
    "PAYLOAD_TOO_LARGE",
    `Request body exceeds the ${limitBytes}-byte limit.`,
  );
}

/**
 * Wraps the request body in a stream that errors with 413 once `limitBytes` is exceeded and
 * cancels the source when `signal` aborts. Reads the original body directly: cancelling a
 * `request.clone()` branch never settles in Deno.
 */
export function limitRequestBody(
  request: Request,
  limitBytes: number,
  signal: AbortSignal,
): Request {
  if (request.body === null) return request;
  if (signal.aborted) throw signal.reason;

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > limitBytes) {
    throw payloadTooLarge(limitBytes);
  }

  const reader = request.body.getReader();
  let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  let total = 0;
  let finished = false;

  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    controller.error(error);
    // Not awaited: the error path must not wait on the source acknowledging cancellation.
    reader.cancel(error).catch(() => undefined);
  };
  const onAbort = () => fail(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });

  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      controller = c;
    },
    async pull(c) {
      let result: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
      try {
        result = await reader.read();
      } catch (error) {
        fail(error);
        return;
      }
      if (finished) return;
      if (result.done) {
        finished = true;
        signal.removeEventListener("abort", onAbort);
        c.close();
        return;
      }
      total += result.value.byteLength;
      if (total > limitBytes) {
        fail(payloadTooLarge(limitBytes));
        return;
      }
      c.enqueue(result.value);
    },
    cancel(reason) {
      finished = true;
      signal.removeEventListener("abort", onAbort);
      reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Request(request, { body });
}

type RequestBodyMediaType = "json" | "form" | "multipart";

function requestBodyMediaType(request: Request): RequestBodyMediaType {
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
  if (
    !contentType || contentType === "application/json" ||
    /^application\/[\w.!#$&^-]+\+json$/.test(contentType)
  ) return "json";
  if (contentType === "application/x-www-form-urlencoded") return "form";
  if (contentType === "multipart/form-data") return "multipart";
  throw new AppError(
    415,
    "UNSUPPORTED_MEDIA_TYPE",
    "The request body media type is not supported.",
  );
}

/** Rejects known unsupported media types without consuming a streamed request body. */
export function assertSupportedRequestMediaType(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) return;
  requestBodyMediaType(request);
}

export async function parseRequestBody(
  request: Request,
  bytes?: Uint8Array<ArrayBuffer>,
): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (bytes === undefined && request.body === null) return undefined;

  const mediaType = requestBodyMediaType(request);

  bytes ??= new Uint8Array(await request.arrayBuffer());

  if (mediaType === "json") {
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError(400, "INVALID_JSON", "Request body is not valid JSON.");
    }
  }

  if (mediaType === "form") {
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
