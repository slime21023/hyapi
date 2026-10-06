/** OIDC resource-server authentication for HyAPI applications. @module */

import { defineGuard, type Guard, type Identity, UnauthorizedError } from "@hyapi/core";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6";

/** Asymmetric JWT signing algorithms supported by the OIDC plugin. */
export type OidcAlgorithm =
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "ES512"
  | "EdDSA";

/** Explicit resource-server verification settings for one OIDC issuer. */
export interface OidcOptions {
  /** Exact issuer claim expected from access tokens. */
  readonly issuer: string;
  /** One or more audience values accepted from access tokens. */
  readonly audience: string | readonly string[];
  /** HTTPS endpoint that serves the issuer's JSON Web Key Set. */
  readonly jwksUrl: string;
  /** Explicit asymmetric signing algorithms accepted from access tokens. */
  readonly algorithms: readonly OidcAlgorithm[];
  /** Admit requests without an Authorization header, leaving the identity empty. */
  readonly optional?: boolean;
  /** OpenAPI security scheme name. Defaults to `bearerAuth`. */
  readonly schemeName?: string;
}

interface NormalizedOidcOptions {
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly jwksUrl: URL;
  readonly algorithms: readonly OidcAlgorithm[];
}

const ALGORITHMS = new Set<OidcAlgorithm>([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

/**
 * Creates a guard that verifies OIDC Bearer access tokens through a remote JWKS endpoint.
 *
 * Missing credentials are rejected with 401 unless `optional` is set; invalid credentials are
 * always rejected with 401 and a `Bearer error="invalid_token"` challenge.
 */
export function oidcBearer(options: OidcOptions): Guard {
  const normalized = normalizeOptions(options);
  const jwks = createRemoteJWKSet(normalized.jwksUrl);
  return defineGuard({
    name: "oidcBearer",
    security: {
      schemes: {
        [options.schemeName ?? "bearerAuth"]: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      ...(options.optional ? { optional: true } : {}),
    },
    async check({ request }): Promise<Identity | void> {
      const token = readBearerToken(request.headers.get("authorization"));
      if (token === null) {
        if (options.optional) return;
        throw new UnauthorizedError(undefined, { challenge: "Bearer" });
      }
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: normalized.issuer,
          audience: [...normalized.audience],
          algorithms: [...normalized.algorithms],
        });
        if (typeof payload.sub !== "string" || payload.sub.length === 0) throw invalidToken();
        return {
          subject: payload.sub,
          scopes: scopesFromClaim(payload.scope),
          claims: Object.freeze({ ...payload }),
        };
      } catch {
        throw invalidToken();
      }
    },
  });
}

function invalidToken(): UnauthorizedError {
  return new UnauthorizedError(undefined, { challenge: 'Bearer error="invalid_token"' });
}

function normalizeOptions(options: OidcOptions): NormalizedOidcOptions {
  validateHttpUrl(options.issuer, "OIDC issuer");
  const jwksUrl = new URL(options.jwksUrl);
  if (jwksUrl.protocol !== "https:") throw new TypeError("OIDC jwksUrl must use HTTPS.");

  const audience = typeof options.audience === "string"
    ? [options.audience]
    : [...options.audience];
  if (
    audience.length === 0 ||
    audience.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new TypeError("OIDC audience must contain at least one value.");
  }

  const algorithms = [...new Set(options.algorithms)];
  if (algorithms.length === 0 || algorithms.some((algorithm) => !ALGORITHMS.has(algorithm))) {
    throw new TypeError("OIDC algorithms must contain supported asymmetric algorithms.");
  }
  return { issuer: options.issuer, audience, jwksUrl, algorithms };
}

function validateHttpUrl(value: string, label: string): void {
  if (typeof value !== "string") throw new TypeError(`${label} must be a URL string.`);
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} must use HTTP or HTTPS.`);
  }
}

function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer +(\S+)$/i.exec(header);
  if (!match?.[1]) throw invalidToken();
  return match[1];
}

function scopesFromClaim(value: unknown): readonly string[] {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}
