/** HS256 bearer-token guard for HyAPI routes. @module */

import {
  ConfigurationError,
  defineGuard,
  type Guard,
  type Identity,
  UnauthorizedError,
} from "@hyapi/core";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Explicit HS256 verification settings. */
export interface JwtBearerOptions {
  /** HMAC secret with at least 32 UTF-8 bytes. Keep it outside source control. */
  readonly secret: string;
  /** Exact `iss` claim required when set. */
  readonly issuer?: string;
  /** `aud` value that must be present when set. */
  readonly audience?: string;
  /** Tolerance for `exp` and `nbf`, in seconds. Defaults to 5. */
  readonly clockSkewSeconds?: number;
  /** Admit requests without an Authorization header, leaving the identity empty. */
  readonly optional?: boolean;
  /** OpenAPI security scheme name. Defaults to `bearerAuth`. */
  readonly schemeName?: string;
}

interface ParsedJwt {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly signature: Uint8Array;
  readonly signingInput: Uint8Array;
}

/**
 * Creates a guard that verifies HS256 Bearer tokens and establishes their identity.
 *
 * Missing credentials are rejected with 401 unless `optional` is set; invalid credentials are
 * always rejected with 401 and a `Bearer error="invalid_token"` challenge.
 */
export function jwtBearer(options: JwtBearerOptions): Guard {
  const secret = textEncoder.encode(options.secret);
  if (secret.length < 32) {
    throw new ConfigurationError("JWT secret must contain at least 32 bytes.");
  }
  if (
    options.clockSkewSeconds !== undefined &&
    !(Number.isFinite(options.clockSkewSeconds) && options.clockSkewSeconds >= 0)
  ) {
    throw new ConfigurationError("JWT clockSkewSeconds must be a non-negative number.");
  }
  const schemeName = options.schemeName ?? "bearerAuth";
  let key: Promise<CryptoKey> | undefined;

  return defineGuard({
    name: "jwtBearer",
    security: {
      schemes: { [schemeName]: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      ...(options.optional ? { optional: true } : {}),
    },
    async check({ request }) {
      const token = readBearerToken(request.headers.get("authorization"));
      if (token === null) {
        if (options.optional) return;
        throw new UnauthorizedError(undefined, { challenge: "Bearer" });
      }
      key ??= crypto.subtle.importKey(
        "raw",
        secret,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const jwt = parseJwt(token);
      validateHeader(jwt.header);
      await verifySignature(jwt, await key);
      return identityFromClaims(jwt.claims, options);
    },
  });
}

function invalidToken(): UnauthorizedError {
  return new UnauthorizedError(undefined, { challenge: 'Bearer error="invalid_token"' });
}

function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer +(\S+)$/i.exec(header);
  if (!match?.[1]) throw invalidToken();
  return match[1];
}

function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw invalidToken();
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (!encodedHeader || !encodedClaims || !encodedSignature) throw invalidToken();

  try {
    return {
      header: decodeJsonObject(encodedHeader),
      claims: decodeJsonObject(encodedClaims),
      signature: decodeBase64Url(encodedSignature),
      signingInput: textEncoder.encode(`${encodedHeader}.${encodedClaims}`),
    };
  } catch {
    throw invalidToken();
  }
}

function validateHeader(header: Record<string, unknown>): void {
  if (header.alg !== "HS256" || header.crit !== undefined) throw invalidToken();
}

async function verifySignature(jwt: ParsedJwt, key: CryptoKey): Promise<void> {
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    jwt.signature as unknown as BufferSource,
    jwt.signingInput as unknown as BufferSource,
  );
  if (!valid) throw invalidToken();
}

function identityFromClaims(claims: Record<string, unknown>, options: JwtBearerOptions): Identity {
  const now = Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 5;
  const exp = claims.exp;
  const nbf = claims.nbf;
  const subject = claims.sub;

  if (!isNumericDate(exp) || now >= exp + skew) throw invalidToken();
  if (nbf !== undefined && (!isNumericDate(nbf) || nbf > now + skew)) throw invalidToken();
  if (options.issuer !== undefined && claims.iss !== options.issuer) throw invalidToken();
  if (options.audience !== undefined && !audienceIncludes(claims.aud, options.audience)) {
    throw invalidToken();
  }
  if (typeof subject !== "string" || subject.length === 0) throw invalidToken();

  return { subject, scopes: scopesFromClaims(claims), claims: Object.freeze(claims) };
}

function audienceIncludes(audience: unknown, expected: string): boolean {
  if (typeof audience === "string") return audience === expected;
  return (
    Array.isArray(audience) &&
    audience.every((value): value is string => typeof value === "string") &&
    audience.includes(expected)
  );
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function scopesFromClaims(claims: Record<string, unknown>): readonly string[] {
  if (typeof claims.scope === "string") return claims.scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(claims.scopes) && claims.scopes.every((value) => typeof value === "string")) {
    return claims.scopes as string[];
  }
  return [];
}

function decodeJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(textDecoder.decode(decodeBase64Url(value)));
  if (!isRecord(parsed)) {
    throw new TypeError("JWT values must be JSON objects.");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("JWT values must be base64url.");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
