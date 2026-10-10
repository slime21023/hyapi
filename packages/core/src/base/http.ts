// HTTP vocabulary shared by the contract compiler and the runtime (ADR 0004 §1). Mechanisms only:
// no diagnostics, no policy, and no state.

/** HTTP methods that an operation may declare. */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "TRACE";

/** The default media type of request and response bodies. */
export const JSON_MEDIA_TYPE = "application/json";

/** The media type of RFC 9457 problem details. */
export const PROBLEM_MEDIA_TYPE = "application/problem+json";

/** Returns true when the value has the form `type/subtype`. */
export function isMediaType(value: string): boolean {
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value);
}

/** JSON media types: `application/json` and any `+json` suffix. Parsed and validated as JSON. */
export function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/** `text/*` media types. Decoded as UTF-8 and validated as strings. */
export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/");
}

// HTTP reason phrases used as default response descriptions.
const PHRASES: Readonly<Record<number, string>> = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
};

/** The reason phrase for a status, or a generic description for unregistered statuses. */
export function reasonPhrase(status: number): string {
  return PHRASES[status] ?? `Status ${status}`;
}
