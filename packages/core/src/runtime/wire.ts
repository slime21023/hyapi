import type { BodyModel, ParameterLocation, ParameterModel } from "../contract/model.ts";

/** The input locations of a handler, keyed as in RFC 0001. */
export const INPUT_KEYS: Readonly<
  Record<ParameterLocation, "params" | "query" | "headers" | "cookies">
> = {
  path: "params",
  query: "query",
  header: "headers",
  cookie: "cookies",
};

type Kind = "array" | "object" | "primitive";

function kindOf(schema: unknown): Kind {
  const type = (schema as { type?: unknown }).type;
  if (type === "array") return "array";
  if (type === "object") return "object";
  return "primitive";
}

/** Splits `k,v,k,v` (explode false) or `k=v,k=v` (explode true) into an object. */
function objectFromList(text: string, explode: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  if (explode) {
    for (const pair of text.split(",")) {
      const index = pair.indexOf("=");
      if (index > 0) result[pair.slice(0, index)] = pair.slice(index + 1);
    }
  } else {
    const parts = text.split(",");
    for (let i = 0; i + 1 < parts.length; i += 2) result[parts[i]!] = parts[i + 1]!;
  }
  return result;
}

function fromText(text: string, parameter: ParameterModel): unknown {
  const kind = kindOf(parameter.schema);
  if (kind === "array") return text === "" ? [] : text.split(",");
  if (kind === "object") return objectFromList(text, parameter.explode);
  return text;
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      cookies.set(name, part.slice(index + 1).trim());
    }
  }
  return cookies;
}

/**
 * Reads the raw (string-valued) parameters of one location. Coercion to schema types and
 * validation happen afterwards; absent parameters are left out.
 */
export function readParameters(
  location: ParameterLocation,
  parameters: readonly ParameterModel[],
  source: {
    readonly params: Readonly<Record<string, string>>;
    readonly url: URL;
    readonly headers: Headers;
  },
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const cookies = location === "cookie" ? parseCookies(source.headers.get("cookie")) : undefined;
  const query = source.url.searchParams;
  for (const parameter of parameters) {
    if (parameter.in !== location) continue;
    const { name } = parameter;
    let value: unknown;
    switch (location) {
      case "path":
        value = source.params[name] === undefined
          ? undefined
          : fromText(source.params[name]!, parameter);
        break;
      case "header": {
        const text = source.headers.get(name);
        value = text === null ? undefined : fromText(text, parameter);
        break;
      }
      case "cookie": {
        const text = cookies!.get(name);
        value = text === undefined ? undefined : fromText(text, parameter);
        break;
      }
      case "query":
        value = readQuery(query, parameter);
        break;
    }
    if (value !== undefined) values[name] = value;
  }
  return values;
}

function readQuery(query: URLSearchParams, parameter: ParameterModel): unknown {
  const { name } = parameter;
  const kind = kindOf(parameter.schema);
  if (parameter.style === "deepObject") {
    const result: Record<string, string> = {};
    const prefix = `${name}[`;
    for (const [key, value] of query) {
      if (key.startsWith(prefix) && key.endsWith("]")) result[key.slice(prefix.length, -1)] = value;
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }
  if (kind === "array") {
    const all = query.getAll(name);
    if (all.length === 0) return undefined;
    return parameter.explode ? all : all.flatMap((value) => value === "" ? [] : value.split(","));
  }
  if (kind === "object" && parameter.explode) {
    // form + explode spreads the object's properties as separate query parameters.
    const properties = (parameter.schema as { properties?: Record<string, unknown> }).properties ??
      {};
    const result: Record<string, string> = {};
    for (const key of Object.keys(properties)) {
      const value = query.get(key);
      if (value !== null) result[key] = value;
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }
  const value = query.get(name);
  return value === null ? undefined : fromText(value, parameter);
}

/** The media type without parameters, lowercased. */
export function mediaTypeOf(contentType: string | null): string | undefined {
  if (contentType === null) return undefined;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "" ? undefined : type;
}

export function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function acceptsMediaType(declared: string, actual: string): boolean {
  if (declared.toLowerCase() === actual) return true;
  return declared === "application/json" && actual.endsWith("+json");
}

/** The outcome of reading a request body. */
export type BodyResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "absent" }
  | { readonly kind: "too-large" }
  | { readonly kind: "unsupported-media-type"; readonly mediaType: string | undefined }
  | { readonly kind: "malformed"; readonly detail: string };

async function readLimited(request: Request, limit: number): Promise<Uint8Array | "too-large"> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads a declared request body within the size limit. JSON is parsed, `text/*` is decoded, and
 * other media types are delivered as bytes.
 */
export async function readBody(
  request: Request,
  body: BodyModel,
  limit: number,
): Promise<BodyResult> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > limit) return { kind: "too-large" };
  const mediaType = mediaTypeOf(request.headers.get("content-type"));
  if (request.body === null || (length === "0" && mediaType === undefined)) {
    return { kind: "absent" };
  }
  if (mediaType === undefined || !acceptsMediaType(body.mediaType, mediaType)) {
    // A client that sends no content type and no bytes has sent no body.
    const bytes = await readLimited(request, limit);
    if (bytes === "too-large") return { kind: "too-large" };
    if (bytes.byteLength === 0 && mediaType === undefined) return { kind: "absent" };
    return { kind: "unsupported-media-type", mediaType };
  }
  const bytes = await readLimited(request, limit);
  if (bytes === "too-large") return { kind: "too-large" };
  if (bytes.byteLength === 0) return { kind: "absent" };
  if (isJsonMediaType(mediaType)) {
    try {
      return {
        kind: "ok",
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      };
    } catch (error) {
      return {
        kind: "malformed",
        detail: `the body is not valid JSON: ${(error as Error).message}`,
      };
    }
  }
  if (mediaType.startsWith("text/")) {
    try {
      return { kind: "ok", value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return { kind: "malformed", detail: "the body is not valid UTF-8 text" };
    }
  }
  return { kind: "ok", value: bytes };
}

/** Serializes a response body for its declared media type. */
export function encodeBody(value: unknown, mediaType: string): BodyInit {
  if (isJsonMediaType(mediaType)) return JSON.stringify(value);
  if (typeof value === "string" || value instanceof Uint8Array || value instanceof Blob) {
    return value as BodyInit;
  }
  if (value instanceof ArrayBuffer || value instanceof ReadableStream) return value;
  return String(value);
}
