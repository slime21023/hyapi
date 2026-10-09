/**
 * Signed double-submit CSRF protection as an outer `fetch` wrapper for HyAPI applications that
 * authenticate browsers with cookies.
 *
 * ```ts
 * const handler = withCsrf(app.fetch, { secret: Deno.env.get("CSRF_SECRET")! });
 * ```
 *
 * Safe requests receive a signed token cookie. Unsafe requests must echo the cookie's token in a
 * header; the token must match the cookie and carry a valid signature. APIs authenticated only
 * with bearer tokens do not need CSRF protection; use `skip` for such requests.
 *
 * @module
 */
import { problemResponse } from "@hyapi/core";

/** A Web-standard request handler, such as `app.fetch`. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Options for {@link withCsrf}. */
export interface CsrfOptions {
  /** The signing secret: at least 32 bytes. */
  readonly secret: string | Uint8Array;
  /**
   * The token cookie. Defaults to `__Host-csrf`, which browsers accept only over HTTPS without a
   * `Domain`; use another name for plain-HTTP development.
   */
  readonly cookieName?: string;
  /** The request header that echoes the token. Defaults to `x-csrf-token`. */
  readonly headerName?: string;
  /** `SameSite` for the token cookie. Defaults to `Lax`. */
  readonly sameSite?: "Strict" | "Lax";
  /** Adds `Secure` to the cookie. Defaults to `true`; required for `__Host-` names. */
  readonly secure?: boolean;
  /** Requests that skip the check, for example those with a bearer token. */
  readonly skip?: (request: Request) => boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Wraps a handler with signed double-submit CSRF protection. Unsafe requests without a valid,
 * matching token get 403 `CSRF_FAILED`.
 */
export function withCsrf(handler: FetchHandler, options: CsrfOptions): FetchHandler {
  const secret = typeof options.secret === "string"
    ? encoder.encode(options.secret)
    : options.secret;
  if (secret.byteLength < 32) throw new RangeError("the CSRF secret must be at least 32 bytes");
  const cookieName = options.cookieName ?? "__Host-csrf";
  const secure = options.secure ?? true;
  if (cookieName.startsWith("__Host-") && !secure) {
    throw new TypeError("a __Host- cookie requires secure: true");
  }
  const headerName = options.headerName ?? "x-csrf-token";
  const sameSite = options.sameSite ?? "Lax";
  const key = crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const issue = async (): Promise<string> => {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key, nonce));
    return `${base64url(nonce)}.${base64url(signature)}`;
  };
  const valid = async (token: string | undefined): Promise<boolean> => {
    const [nonce, signature, extra] = (token ?? "").split(".");
    if (!nonce || !signature || extra !== undefined) return false;
    const nonceBytes = fromBase64url(nonce);
    const signatureBytes = fromBase64url(signature);
    if (nonceBytes === undefined || signatureBytes === undefined) return false;
    return await crypto.subtle.verify(
      "HMAC",
      await key,
      signatureBytes as Uint8Array<ArrayBuffer>,
      nonceBytes as Uint8Array<ArrayBuffer>,
    );
  };
  const cookie = (token: string) =>
    `${cookieName}=${token}; Path=/; SameSite=${sameSite}${secure ? "; Secure" : ""}`;

  return async (request) => {
    if (options.skip?.(request) === true) return await handler(request);
    // A CORS preflight carries no credentials and must not receive a cookie.
    const preflight = request.method === "OPTIONS" &&
      request.headers.has("access-control-request-method");
    if (preflight) return await handler(request);
    const current = readCookie(request.headers.get("cookie"), cookieName);
    if (!SAFE_METHODS.has(request.method)) {
      const echoed = request.headers.get(headerName) ?? undefined;
      const matches = current !== undefined && echoed === current && await valid(current);
      return matches ? await handler(request) : problemResponse(403, "CSRF_FAILED", {
        detail: `Send the ${cookieName} cookie's token in the ${headerName} header.`,
      });
    }
    const response = await handler(request);
    if (await valid(current)) return response;
    // Issue a token on safe requests that lack a valid one; the browser's script reads the
    // cookie (it is deliberately not HttpOnly) and echoes it on unsafe requests.
    const headers = new Headers(response.headers);
    headers.append("set-cookie", cookie(await issue()));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
