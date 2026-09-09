import { type AuthProvider, definePlugin, type Identity, type Plugin } from "../types.ts";
import { ConfigurationError, UnauthorizedError } from "../errors.ts";

export interface JwtOptions {
  readonly secret: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly clockSkewSeconds?: number;
}

interface JwtHeader {
  alg?: unknown;
  typ?: unknown;
}

interface JwtClaims {
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iss?: unknown;
  aud?: unknown;
  scope?: unknown;
  scopes?: unknown;
  [key: string]: unknown;
}

export class JwtAuthProvider implements AuthProvider {
  private constructor(
    private readonly options: JwtOptions,
    private readonly key: CryptoKey,
  ) {}

  static async create(options: JwtOptions): Promise<JwtAuthProvider> {
    if (options.secret.length < 32) {
      throw new ConfigurationError("JWT secret must contain at least 32 characters.");
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(options.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return new JwtAuthProvider(options, key);
  }

  async authenticate(request: Request): Promise<Identity | null> {
    const header = request.headers.get("authorization");
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match?.[1]) throw new UnauthorizedError("A bearer token is required.");

    const token = match[1];
    const parts = token.split(".");
    if (parts.length !== 3) throw new UnauthorizedError("The bearer token is malformed.");
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (!encodedHeader || !encodedClaims || !encodedSignature) {
      throw new UnauthorizedError("The bearer token is malformed.");
    }

    let headerValue: JwtHeader;
    let claims: JwtClaims;
    let signatureBytes: Uint8Array;
    try {
      headerValue = JSON.parse(decodeBase64Url(encodedHeader)) as JwtHeader;
      claims = JSON.parse(decodeBase64Url(encodedClaims)) as JwtClaims;
      signatureBytes = decodeBytes(encodedSignature);
    } catch {
      throw new UnauthorizedError("The bearer token is malformed.");
    }
    if (headerValue.alg !== "HS256") throw new UnauthorizedError("Only HS256 tokens are accepted.");

    const valid = await crypto.subtle.verify(
      "HMAC",
      this.key,
      signatureBytes as unknown as BufferSource,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    if (!valid) throw new UnauthorizedError("The bearer token signature is invalid.");

    const now = Math.floor(Date.now() / 1000);
    const skew = this.options.clockSkewSeconds ?? 5;
    if (typeof claims.exp !== "number" || claims.exp < now - skew) {
      throw new UnauthorizedError("The bearer token has expired or has no expiration.");
    }
    if (typeof claims.nbf === "number" && claims.nbf > now + skew) {
      throw new UnauthorizedError("The bearer token is not active yet.");
    }
    if (this.options.issuer !== undefined && claims.iss !== this.options.issuer) {
      throw new UnauthorizedError("The bearer token issuer is invalid.");
    }
    if (
      this.options.audience !== undefined && !audienceIncludes(claims.aud, this.options.audience)
    ) {
      throw new UnauthorizedError("The bearer token audience is invalid.");
    }
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new UnauthorizedError("The bearer token has no subject.");
    }

    return {
      subject: claims.sub,
      scopes: scopesFromClaims(claims),
      claims,
    };
  }
}

export function jwtPlugin(options: JwtOptions): Plugin {
  return definePlugin({
    name: "jwt",
    async setup(platform) {
      const provider = await JwtAuthProvider.create(options);
      platform.setAuthProvider(provider);
    },
  });
}

function audienceIncludes(audience: unknown, expected: string): boolean {
  if (typeof audience === "string") return audience === expected;
  return Array.isArray(audience) && audience.includes(expected);
}

function scopesFromClaims(claims: JwtClaims): readonly string[] {
  if (typeof claims.scope === "string") return claims.scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(claims.scopes) && claims.scopes.every((value) => typeof value === "string")) {
    return claims.scopes as string[];
  }
  return [];
}

function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(decodeBytes(value));
}

function decodeBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
