/** JSON media types: `application/json` and any `+json` suffix. Parsed and validated as JSON. */
export function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/** `text/*` media types. Decoded as UTF-8 and validated as strings. */
export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/");
}
