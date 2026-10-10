import { isJsonMediaType, isTextMediaType } from "../base/http.ts";
import type { BodyModel } from "../contract/model.ts";

/** The media type without parameters, lowercased. */
export function mediaTypeOf(contentType: string | null): string | undefined {
  if (contentType === null) return undefined;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "" ? undefined : type;
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

/** Reads the body up to `limit` bytes. Aborting `signal` cancels the read and rejects. */
async function readLimited(
  request: Request,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array | "too-large"> {
  if (request.body === null) return new Uint8Array();
  signal.throwIfAborted();
  const reader = request.body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks = await readChunks(reader, limit, signal);
    return chunks === "too-large" ? chunks : concat(chunks);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Reads every chunk, stopping early once more than `limit` bytes arrived. */
async function readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array[] | "too-large"> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    signal.throwIfAborted();
    if (done) return chunks;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads a declared request body within the size limit. JSON is parsed, `text/*` is decoded, and
 * other media types are delivered as bytes. Aborting `signal` cancels the read and rejects with
 * its reason.
 */
export async function readBody(
  request: Request,
  body: BodyModel,
  limit: number,
  signal: AbortSignal,
): Promise<BodyResult> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > limit) return { kind: "too-large" };
  const mediaType = mediaTypeOf(request.headers.get("content-type"));
  if (request.body === null || (length === "0" && mediaType === undefined)) {
    return { kind: "absent" };
  }
  if (mediaType === undefined || !acceptsMediaType(body.mediaType, mediaType)) {
    // A client that sends no content type and no bytes has sent no body.
    const bytes = await readLimited(request, limit, signal);
    if (bytes === "too-large") return { kind: "too-large" };
    if (bytes.byteLength === 0 && mediaType === undefined) return { kind: "absent" };
    return { kind: "unsupported-media-type", mediaType };
  }
  const bytes = await readLimited(request, limit, signal);
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
  if (isTextMediaType(mediaType)) {
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
