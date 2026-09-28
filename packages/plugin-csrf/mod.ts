/** CSRF handling for cookie-authenticated browser requests. @module */

type HttpHandler = (request: Request) => Response | Promise<Response>;

/** Cookie settings for tokens issued by the CSRF wrapper. */
export interface CsrfCookieOptions {
  /** Cookie name. Defaults to the host-only `__Host-hyapi-csrf` name. */
  readonly name?: string;
  /** Adds the Secure attribute. Defaults to `true`. */
  readonly secure?: boolean;
  /** Browser SameSite policy. Defaults to `lax`. */
  readonly sameSite?: "lax" | "strict" | "none";
}

/** Explicit signed double-submit CSRF rules for one HTTP handler. */
export interface CsrfOptions {
  /** Exact browser origins allowed to send unsafe requests. */
  readonly origins: readonly string[];
  /** HMAC secret with at least 32 UTF-8 bytes. Keep it outside source control. */
  readonly secret: string;
  /** Cookie settings for issued tokens. */
  readonly cookie?: CsrfCookieOptions;
  /** Request header containing the token. Defaults to `x-csrf-token`. */
  readonly headerName?: string;
}

interface NormalizedCsrfOptions {
  readonly origins: ReadonlySet<string>;
  readonly secret: Uint8Array;
  readonly cookieName: string;
  readonly secure: boolean;
  readonly sameSite: "Lax" | "Strict" | "None";
  readonly headerName: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

/**
 * Adds signed double-submit CSRF protection around a native HTTP handler.
 *
 * Safe requests receive a token cookie when needed. Unsafe requests must supply the same signed
 * token in that cookie and in the configured request header, and must come from an allowed origin.
 * Bearer clients are intentionally not special-cased: select this wrapper only for cookie-authenticated
 * browser endpoints.
 */
export function withCsrf(next: HttpHandler, options: CsrfOptions): HttpHandler {
  const policy = normalizeOptions(options);
  const key = crypto.subtle.importKey(
    "raw",
    asBufferSource(policy.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  return async (request) => {
    if (SAFE_METHODS.has(request.method)) {
      const response = await next(request);
      const token = readCookie(request.headers.get("cookie"), policy.cookieName);
      if (token !== undefined && await verifiesToken(token, key)) return response;
      return withTokenCookie(response, await createToken(key), policy);
    }

    if (!allowsRequest(request, policy) || !await hasValidToken(request, key, policy)) {
      return csrfRejected();
    }
    return await next(request);
  };
}

function normalizeOptions(options: CsrfOptions): NormalizedCsrfOptions {
  const origins = new Set<string>();
  if (options.origins.length === 0) throw new TypeError("CSRF origins must not be empty.");
  for (const value of options.origins) {
    if (typeof value !== "string" || value === "*") {
      throw new TypeError("CSRF origins must be exact HTTP or HTTPS origins.");
    }
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("CSRF origins must use HTTP or HTTPS.");
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new TypeError("CSRF origins must not include a path, query, or hash.");
    }
    origins.add(url.origin);
  }

  if (typeof options.secret !== "string") throw new TypeError("CSRF secret must be a string.");
  const secret = encoder.encode(options.secret);
  if (secret.byteLength < 32) {
    throw new TypeError("CSRF secret must contain at least 32 UTF-8 bytes.");
  }

  const cookieName = options.cookie?.name ?? "__Host-hyapi-csrf";
  if (!TOKEN.test(cookieName)) throw new TypeError("CSRF cookie name must be an HTTP token.");
  const secure = options.cookie?.secure ?? true;
  if (cookieName.startsWith("__Host-") && !secure) {
    throw new TypeError("A __Host- CSRF cookie requires secure: true.");
  }
  const sameSite = normalizeSameSite(options.cookie?.sameSite ?? "lax");
  if (sameSite === "None" && !secure) {
    throw new TypeError("CSRF SameSite=None requires secure: true.");
  }

  const headerName = (options.headerName ?? "x-csrf-token").toLowerCase();
  if (!TOKEN.test(headerName)) throw new TypeError("CSRF headerName must be an HTTP token.");
  return { origins, secret, cookieName, secure, sameSite, headerName };
}

function normalizeSameSite(value: CsrfCookieOptions["sameSite"]): "Lax" | "Strict" | "None" {
  switch (value) {
    case "lax":
      return "Lax";
    case "strict":
      return "Strict";
    case "none":
      return "None";
    default:
      throw new TypeError("CSRF sameSite must be lax, strict, or none.");
  }
}

function allowsRequest(request: Request, options: NormalizedCsrfOptions): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && options.origins.has(origin);
}

async function hasValidToken(
  request: Request,
  key: Promise<CryptoKey>,
  options: NormalizedCsrfOptions,
): Promise<boolean> {
  const cookieToken = readCookie(request.headers.get("cookie"), options.cookieName);
  const headerToken = request.headers.get(options.headerName);
  return cookieToken !== undefined && headerToken === cookieToken &&
    await verifiesToken(cookieToken, key);
}

async function createToken(key: Promise<CryptoKey>): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const encodedNonce = toBase64Url(nonce);
  const signature = await crypto.subtle.sign("HMAC", await key, encoder.encode(encodedNonce));
  return `${encodedNonce}.${toBase64Url(new Uint8Array(signature))}`;
}

async function verifiesToken(token: string, key: Promise<CryptoKey>): Promise<boolean> {
  const [encodedNonce, encodedSignature, extra] = token.split(".");
  if (!encodedNonce || !encodedSignature || extra !== undefined) return false;

  try {
    const signature = fromBase64Url(encodedSignature);
    return await crypto.subtle.verify(
      "HMAC",
      await key,
      asBufferSource(signature),
      encoder.encode(encodedNonce),
    );
  } catch {
    return false;
  }
}

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName === name) return value.join("=");
  }
  return undefined;
}

function withTokenCookie(
  response: Response,
  token: string,
  options: NormalizedCsrfOptions,
): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", serializeCookie(token, options));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function serializeCookie(token: string, options: NormalizedCsrfOptions): string {
  const attributes = [
    `${options.cookieName}=${token}`,
    "Path=/",
    `SameSite=${options.sameSite}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

function csrfRejected(): Response {
  return Response.json(
    {
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      code: "CSRF_REJECTED",
      detail: "CSRF validation failed.",
    },
    {
      status: 403,
      headers: { "content-type": "application/problem+json" },
    },
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!BASE64_URL.test(value)) throw new TypeError("Invalid base64url value.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
