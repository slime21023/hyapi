/**
 * A HyAPI security verifier for OpenID Connect bearer tokens. It discovers the issuer's JWKS
 * and verifies tokens with [jose](https://jsr.io/@panva/jose), which caches and rotates keys.
 *
 * ```ts
 * const security = defineSecurity({
 *   oidc: openIdConnect<{ subject: string }>({ url: "https://id.example.com/.well-known/openid-configuration" }),
 * });
 * const app = await createApp({
 *   api,
 *   implementations,
 *   verifiers: {
 *     oidc: await oidcBearer({
 *       issuer: "https://id.example.com",
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
  createRemoteJWKSet,
  customFetch,
  errors,
  type JWTPayload,
  jwtVerify,
  type JWTVerifyOptions,
} from "jsr:@panva/jose@^6";
import type { Verified, VerifierContext } from "@hyapi/core";

export type { JWTPayload } from "jsr:@panva/jose@^6";

/** Asymmetric algorithms accepted by {@link oidcBearer}. */
export type OidcAlgorithm = "RS256" | "PS256" | "ES256" | "EdDSA";

/** Options for {@link oidcBearer}. */
export interface OidcBearerOptions<Identity> {
  /** The issuer URL; tokens must carry exactly this `iss`. */
  readonly issuer: string;
  /** Accepted `aud` values; required so that tokens for other services are rejected. */
  readonly audience: string | readonly string[];
  /** Accepted algorithms. Defaults to RS256, PS256, ES256, and EdDSA; symmetric ones never apply. */
  readonly algorithms?: readonly OidcAlgorithm[];
  /** The JWKS URL. Defaults to the `jwks_uri` from the issuer's discovery document. */
  readonly jwksUri?: string;
  /** Timeout for discovery and key requests. Defaults to 5000 ms. */
  readonly fetchTimeoutMs?: number;
  /** How long fetched keys are trusted before refetching. Defaults to 10 minutes. */
  readonly cacheMaxAgeMs?: number;
  /** Allowed clock skew in seconds. Defaults to 0. */
  readonly clockToleranceSeconds?: number;
  /** Maps verified claims to the scheme's identity; `null` rejects. Defaults to the claims. */
  readonly identity?: (claims: JWTPayload) => Identity | null;
  /** Reads granted scopes. Defaults to the space-separated `scope` claim or the `scp` array. */
  readonly scopes?: (claims: JWTPayload) => readonly string[];
}

/** A verifier for `openIdConnect`, `oauth2`, or `httpBearer` schemes. */
export type OidcVerifier<Identity> = (
  token: string,
  ctx: VerifierContext,
) => Promise<Verified<Identity> | null>;

const ALGORITHMS: readonly OidcAlgorithm[] = ["RS256", "PS256", "ES256", "EdDSA"];

/** The key server failed; never mistaken for an invalid token. */
class KeyServerError extends Error {
  override name = "KeyServerError";
}

/** jose reports a non-200 JWKS answer as a generic JOSEError; surface it as a server failure. */
async function fetchKeys(url: string, options: RequestInit): Promise<Response> {
  const response = await fetch(url, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new KeyServerError(`the JWKS endpoint ${url} answered ${response.status}`);
  }
  return response;
}

function defaultScopes(claims: JWTPayload): readonly string[] {
  if (typeof claims.scope === "string") return claims.scope.split(" ").filter(Boolean);
  if (Array.isArray(claims.scp)) {
    return claims.scp.filter((s): s is string => typeof s === "string");
  }
  return [];
}

async function discover(issuer: string, timeoutMs: number): Promise<string> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OIDC discovery at ${url} answered ${response.status}`);
  }
  const document = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
  if (document.issuer !== issuer) {
    throw new Error(
      `OIDC discovery issuer '${String(document.issuer)}' does not match '${issuer}'`,
    );
  }
  if (typeof document.jwks_uri !== "string") {
    throw new Error(`OIDC discovery at ${url} has no jwks_uri`);
  }
  return document.jwks_uri;
}

/**
 * Creates an OIDC bearer verifier. Unless `jwksUri` is given, the issuer's discovery document is
 * fetched now, so an unreachable or misconfigured issuer fails startup.
 *
 * An invalid, expired, or foreign token yields `null` (401). An unreachable key server throws, so
 * the request fails with 500 instead of being treated as unauthenticated.
 */
export async function oidcBearer<Identity = JWTPayload>(
  options: OidcBearerOptions<Identity>,
): Promise<OidcVerifier<Identity>> {
  if (typeof options.issuer !== "string" || !/^https?:\/\//.test(options.issuer)) {
    throw new TypeError("issuer must be an http(s) URL");
  }
  const algorithms = [...(options.algorithms ?? ALGORITHMS)];
  if (algorithms.length === 0 || algorithms.some((a) => !ALGORITHMS.includes(a))) {
    throw new TypeError(`algorithms must be some of ${ALGORITHMS.join(", ")}`);
  }
  const timeoutMs = options.fetchTimeoutMs ?? 5_000;
  const jwksUri = options.jwksUri ?? (await discover(options.issuer, timeoutMs));
  const keys = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: timeoutMs,
    cacheMaxAge: options.cacheMaxAgeMs ?? 600_000,
    [customFetch]: fetchKeys,
  });
  const identityOf = options.identity ?? ((claims: JWTPayload) => claims as Identity);
  const scopesOf = options.scopes ?? defaultScopes;
  const verifyOptions = {
    issuer: options.issuer,
    audience: options.audience as string | string[],
    algorithms,
    clockTolerance: options.clockToleranceSeconds ?? 0,
    requiredClaims: ["exp"],
  };

  return async (token) => {
    const claims = await verifiedClaims(token, keys, verifyOptions);
    if (claims === null) return null;
    const identity = identityOf(claims);
    return identity === null ? null : { identity, scopes: scopesOf(claims) };
  };
}

/** Errors from fetching or reading the key set: internal errors, never "invalid token". */
function isKeyServerFailure(error: unknown): boolean {
  return error instanceof KeyServerError || error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid;
}

/** The claims of a valid token; null when the token is invalid. Other errors are thrown. */
async function verifiedClaims(
  token: string,
  keys: ReturnType<typeof createRemoteJWKSet>,
  options: JWTVerifyOptions,
): Promise<JWTPayload | null> {
  try {
    return (await jwtVerify(token, keys, options)).payload;
  } catch (error) {
    if (!isKeyServerFailure(error) && error instanceof errors.JOSEError) return null;
    throw error;
  }
}
