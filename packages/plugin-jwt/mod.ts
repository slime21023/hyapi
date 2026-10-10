/**
 * A HyAPI security verifier for JWT bearer tokens, built on
 * [jose](https://jsr.io/@panva/jose).
 *
 * ```ts
 * const app = await createApp({
 *   api,
 *   implementations,
 *   verifiers: {
 *     bearer: await jwtBearer({
 *       algorithm: "ES256",
 *       key: Deno.env.get("JWT_PUBLIC_KEY")!,
 *       issuer: "https://auth.example.com",
 *       audience: "orders-api",
 *       identity: (claims) => (claims.sub ? { subject: claims.sub } : null),
 *     }),
 *   },
 * });
 * ```
 *
 * @module
 */
import {
  errors,
  importJWK,
  importSPKI,
  type JWK,
  type JWTPayload,
  jwtVerify,
  type JWTVerifyOptions,
} from "jsr:@panva/jose@^6";
import type { Verified, VerifierContext } from "@hyapi/core";

export type { JWTPayload } from "jsr:@panva/jose@^6";

/** Algorithms accepted by {@link jwtBearer}. Exactly one is accepted per verifier. */
export type JwtAlgorithm = "HS256" | "RS256" | "ES256" | "EdDSA";

/** Options for {@link jwtBearer}. */
export interface JwtBearerOptions<Identity> {
  /** The only algorithm accepted; tokens signed with any other algorithm are rejected. */
  readonly algorithm: JwtAlgorithm;
  /**
   * For `HS256`, a secret of at least 32 bytes. For the other algorithms, the public key as a
   * `CryptoKey`, a JWK, or an SPKI PEM string.
   */
  readonly key: string | Uint8Array | CryptoKey | JWK;
  /** Accepted `iss` values. */
  readonly issuer?: string | readonly string[];
  /**
   * Accepted `aud` values. Required: without an audience check, a token issued for any other
   * service that trusts the same key would be accepted.
   */
  readonly audience: string | readonly string[];
  /** Allowed clock skew for `exp`, `nbf`, and `iat`. Defaults to 0 seconds. */
  readonly clockToleranceSeconds?: number;
  /** Claims that must be present. Defaults to `["exp"]`. */
  readonly requiredClaims?: readonly string[];
  /**
   * Maps verified claims to the scheme's identity; return `null` to reject the token. Defaults to
   * the claims themselves.
   */
  readonly identity?: (claims: JWTPayload) => Identity | null;
  /**
   * Reads granted scopes from the claims. Defaults to the space-separated `scope` claim, or the
   * `scp` array claim.
   */
  readonly scopes?: (claims: JWTPayload) => readonly string[];
}

const ALGORITHMS: readonly JwtAlgorithm[] = ["HS256", "RS256", "ES256", "EdDSA"];
const MIN_SECRET_BYTES = 32;

function defaultScopes(claims: JWTPayload): readonly string[] {
  if (typeof claims.scope === "string") return claims.scope.split(" ").filter(Boolean);
  if (Array.isArray(claims.scp)) {
    return claims.scp.filter((s): s is string => typeof s === "string");
  }
  return [];
}

async function importKey(
  algorithm: JwtAlgorithm,
  key: JwtBearerOptions<unknown>["key"],
): Promise<CryptoKey | Uint8Array> {
  if (algorithm === "HS256") {
    const secret = typeof key === "string" ? new TextEncoder().encode(key) : key;
    if (!(secret instanceof Uint8Array)) {
      throw new TypeError("HS256 needs a secret as a string or Uint8Array");
    }
    if (secret.byteLength < MIN_SECRET_BYTES) {
      throw new RangeError(`the HS256 secret must be at least ${MIN_SECRET_BYTES} bytes`);
    }
    return secret;
  }
  if (typeof key === "string") return await importSPKI(key, algorithm);
  if (key instanceof Uint8Array) {
    throw new TypeError(`${algorithm} needs a public key, not a secret`);
  }
  if (key instanceof CryptoKey) return key;
  const imported = await importJWK(key, algorithm);
  if (imported instanceof Uint8Array) throw new TypeError(`${algorithm} needs a public key`);
  return imported;
}

/**
 * Creates a verifier for JWT bearer tokens. The key is imported and the options are checked
 * immediately, so configuration errors surface at startup.
 *
 * An invalid, expired, or mis-signed token yields `null` (401). Unexpected failures throw (500).
 */
export async function jwtBearer<Identity = JWTPayload>(
  options: JwtBearerOptions<Identity>,
): Promise<(token: string, ctx: VerifierContext) => Promise<Verified<Identity> | null>> {
  if (!ALGORITHMS.includes(options.algorithm)) {
    throw new TypeError(`algorithm must be one of ${ALGORITHMS.join(", ")}`);
  }
  const tolerance = options.clockToleranceSeconds ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("clockToleranceSeconds must be a non-negative number");
  }
  const audiences = typeof options.audience === "string" ? [options.audience] : options.audience;
  if (!Array.isArray(audiences) || audiences.length === 0 || audiences.some((a) => !a)) {
    throw new TypeError("audience must name this API, such as 'orders-api'");
  }
  const key = await importKey(options.algorithm, options.key);
  const identityOf = options.identity ?? ((claims: JWTPayload) => claims as Identity);
  const scopesOf = options.scopes ?? defaultScopes;
  const verifyOptions = {
    algorithms: [options.algorithm],
    clockTolerance: tolerance,
    requiredClaims: [...(options.requiredClaims ?? ["exp"])],
    ...(options.issuer === undefined ? {} : { issuer: options.issuer as string | string[] }),
    audience: options.audience as string | string[],
  };

  return async (token) => {
    const claims = await verifiedClaims(token, key, verifyOptions);
    if (claims === null) return null;
    const identity = identityOf(claims);
    return identity === null ? null : { identity, scopes: scopesOf(claims) };
  };
}

/** The claims of a valid token; null when the token is invalid. Other errors are thrown. */
async function verifiedClaims(
  token: string,
  key: CryptoKey | Uint8Array,
  options: JWTVerifyOptions,
): Promise<JWTPayload | null> {
  try {
    return (await jwtVerify(token, key, options)).payload;
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}
