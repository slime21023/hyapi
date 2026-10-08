/** An OAuth 2 flow as declared in OpenAPI. */
export interface OAuthFlow {
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly refreshUrl?: string;
  readonly scopes: Readonly<Record<string, string>>;
}

/** The OAuth 2 flows of a scheme. At least one flow is required. */
export interface OAuthFlows {
  readonly implicit?: OAuthFlow;
  readonly password?: OAuthFlow;
  readonly clientCredentials?: OAuthFlow;
  readonly authorizationCode?: OAuthFlow;
}

/** The OpenAPI description of a security scheme. */
export type SchemeSpec =
  | {
    readonly type: "http";
    readonly scheme: "bearer";
    readonly bearerFormat?: string;
    readonly description?: string;
  }
  | { readonly type: "http"; readonly scheme: "basic"; readonly description?: string }
  | {
    readonly type: "apiKey";
    readonly in: "header" | "query" | "cookie";
    readonly name: string;
    readonly description?: string;
  }
  | { readonly type: "oauth2"; readonly flows: OAuthFlows; readonly description?: string }
  | {
    readonly type: "openIdConnect";
    readonly openIdConnectUrl: string;
    readonly description?: string;
  };

/**
 * A security scheme. `Identity` is the value that the scheme's verifier returns. It exists only
 * in types.
 */
export interface Scheme<Identity = unknown> {
  readonly spec: SchemeSpec;
  readonly "~identity"?: Identity;
}

/** Security schemes keyed by name. */
export type Schemes = Readonly<Record<string, Scheme>>;

/** The identity type declared by a scheme. */
export type IdentityOf<S> = S extends Scheme<infer Identity> ? Identity : never;

/** A module of security schemes, shared by `defineApi` and every `defineContract`. */
export interface Security<S extends Schemes = Schemes> {
  readonly kind: "hyapi.security";
  readonly schemes: S;
}

/**
 * One security requirement: every listed scheme must succeed (AND). A requirement list is a set
 * of alternatives (OR). Scheme names are checked by type; scopes are checked by diagnostics.
 */
export type Requirement<S extends Schemes> = [keyof S] extends [never]
  ? Readonly<Record<string, never>>
  : { readonly [K in keyof S]?: readonly string[] };

/** Declares the security schemes of an API. */
export function defineSecurity<const S extends Schemes>(schemes: S): Security<S> {
  return Object.freeze({ kind: "hyapi.security", schemes });
}

function scheme<Identity>(spec: SchemeSpec): Scheme<Identity> {
  return Object.freeze({ spec });
}

/** An HTTP bearer scheme (`Authorization: Bearer <token>`). */
export function httpBearer<Identity>(
  options: { readonly bearerFormat?: string; readonly description?: string } = {},
): Scheme<Identity> {
  return scheme({ type: "http", scheme: "bearer", ...options });
}

/** An HTTP basic scheme (`Authorization: Basic <credentials>`). */
export function httpBasic<Identity>(
  options: { readonly description?: string } = {},
): Scheme<Identity> {
  return scheme({ type: "http", scheme: "basic", ...options });
}

/** An API key in a header, query parameter, or cookie. */
export function apiKey<Identity>(options: {
  readonly in: "header" | "query" | "cookie";
  readonly name: string;
  readonly description?: string;
}): Scheme<Identity> {
  return scheme({ type: "apiKey", ...options });
}

/** An OAuth 2 scheme. Its access token is presented as a bearer token. */
export function oauth2<Identity>(options: {
  readonly flows: OAuthFlows;
  readonly description?: string;
}): Scheme<Identity> {
  return scheme({ type: "oauth2", ...options });
}

/** An OpenID Connect scheme. Its ID or access token is presented as a bearer token. */
export function openIdConnect<Identity>(options: {
  readonly url: string;
  readonly description?: string;
}): Scheme<Identity> {
  const { url, ...rest } = options;
  return scheme({ type: "openIdConnect", openIdConnectUrl: url, ...rest });
}
