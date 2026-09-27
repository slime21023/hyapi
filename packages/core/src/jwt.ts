import { type AuthProvider, type Identity, type Plugin } from "./types.ts";
import { ConfigurationError, UnauthorizedError } from "./errors.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface JwtOptions {
  readonly secret: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly clockSkewSeconds?: number;
}

interface ParsedJwt {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly signature: Uint8Array;
  readonly signingInput: Uint8Array;
}

export class JwtAuthProvider implements AuthProvider {
  private constructor(
    private readonly options: JwtOptions,
    private readonly key: CryptoKey,
  ) {}

  static async create(options: JwtOptions): Promise<JwtAuthProvider> {
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
    const key = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return new JwtAuthProvider(options, key);
  }

  async authenticate(request: Request): Promise<Identity | null> {
    const token = readBearerToken(request.headers.get("authorization"));
    if (token === null) return null;

    const jwt = parseJwt(token);
    validateHeader(jwt.header);
    await verifySignature(jwt, this.key);
    return identityFromClaims(jwt.claims, this.options);
  }
}

export function jwtPlugin(options: JwtOptions): Plugin {
  return {
    name: "jwt",
    async setup(platform) {
      const provider = await JwtAuthProvider.create(options);
      platform.setAuthProvider(provider);
    },
  };
}

function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer +(\S+)$/i.exec(header);
  if (!match?.[1]) throw new UnauthorizedError();
  return match[1];
}

function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new UnauthorizedError();
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (!encodedHeader || !encodedClaims || !encodedSignature) throw new UnauthorizedError();

  try {
    return {
      header: decodeJsonObject(encodedHeader),
      claims: decodeJsonObject(encodedClaims),
      signature: decodeBase64Url(encodedSignature),
      signingInput: textEncoder.encode(`${encodedHeader}.${encodedClaims}`),
    };
  } catch {
    throw new UnauthorizedError();
  }
}

function validateHeader(header: Record<string, unknown>): void {
  if (header.alg !== "HS256" || header.crit !== undefined) throw new UnauthorizedError();
}

async function verifySignature(jwt: ParsedJwt, key: CryptoKey): Promise<void> {
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    jwt.signature as unknown as BufferSource,
    jwt.signingInput as unknown as BufferSource,
  );
  if (!valid) throw new UnauthorizedError();
}

function identityFromClaims(claims: Record<string, unknown>, options: JwtOptions): Identity {
  const now = Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 5;
  const exp = claims.exp;
  const nbf = claims.nbf;
  const subject = claims.sub;

  if (!isNumericDate(exp) || now >= exp + skew) throw new UnauthorizedError();
  if (nbf !== undefined && (!isNumericDate(nbf) || nbf > now + skew)) {
    throw new UnauthorizedError();
  }
  if (options.issuer !== undefined && claims.iss !== options.issuer) throw new UnauthorizedError();
  if (options.audience !== undefined && !audienceIncludes(claims.aud, options.audience)) {
    throw new UnauthorizedError();
  }
  if (typeof subject !== "string" || subject.length === 0) throw new UnauthorizedError();

  return { subject, scopes: scopesFromClaims(claims) };
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
