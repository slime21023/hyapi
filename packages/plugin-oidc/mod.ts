/** OIDC resource-server authentication for HyAPI applications. @module */

import { type AuthProvider, type Identity, type Plugin, UnauthorizedError } from "@hyapi/core";
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

/** Creates a plugin that verifies OIDC Bearer access tokens through a remote JWKS endpoint. */
export function oidcPlugin(options: OidcOptions): Plugin {
  const normalized = normalizeOptions(options);
  return {
    name: "oidc",
    setup(platform) {
      platform.setAuthProvider(new OidcAuthProvider(normalized));
    },
  };
}

class OidcAuthProvider implements AuthProvider {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: NormalizedOidcOptions) {
    this.#jwks = createRemoteJWKSet(options.jwksUrl);
  }

  async authenticate(request: Request): Promise<Identity | null> {
    const token = readBearerToken(request.headers.get("authorization"));
    if (token === null) return null;

    try {
      const { payload } = await jwtVerify(token, this.#jwks, {
        issuer: this.options.issuer,
        audience: [...this.options.audience],
        algorithms: [...this.options.algorithms],
      });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new UnauthorizedError();
      }
      return { subject: payload.sub, scopes: scopesFromClaim(payload.scope) };
    } catch {
      throw new UnauthorizedError();
    }
  }
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
  if (!match?.[1]) throw new UnauthorizedError();
  return match[1];
}

function scopesFromClaim(value: unknown): readonly string[] {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}
