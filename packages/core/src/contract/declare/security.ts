import type { OAuthFlows, SchemeSpec } from "../model.ts";

/** The decoded credential of an HTTP basic scheme. */
export interface BasicCredential {
  readonly username: string;
  readonly password: string;
}

/** The spec of an HTTP basic scheme, whose credential is decoded into a {@link BasicCredential}. */
export type BasicSpec = Extract<SchemeSpec, { readonly scheme: "basic" }>;

/**
 * A security scheme. Its verifier receives a string credential (a bearer token or an API key),
 * or a {@link BasicCredential} for HTTP basic, which the `spec` tells apart.
 *
 * @typeParam Identity - What the scheme's verifier returns for a valid credential; handlers see it
 *   in `ctx.security`. It exists only in types.
 */
export interface Scheme<Identity = unknown> {
  readonly spec: SchemeSpec;
  readonly "~identity"?: Identity;
}

/** An HTTP basic scheme. */
export interface BasicScheme<Identity = unknown> extends Scheme<Identity> {
  readonly spec: BasicSpec;
}

/** Security schemes keyed by name. */
export type Schemes = Readonly<Record<string, Scheme>>;

/** The identity type declared by a scheme. */
export type IdentityOf<SchemeType> = SchemeType extends Scheme<infer Identity> ? Identity : never;

/** The credential that a scheme's verifier receives. */
export type CredentialOf<SchemeType> = SchemeType extends BasicScheme ? BasicCredential : string;

/**
 * A module of security schemes, shared by `defineApi` and every `defineContract`.
 *
 * @typeParam SchemeSet - The schemes by name, as declared with {@link defineSecurity}.
 */
export interface Security<SchemeSet extends Schemes = Schemes> {
  readonly kind: "hyapi.security";
  readonly schemes: SchemeSet;
}

/**
 * One security requirement: every listed scheme must succeed (AND). A requirement list is a set
 * of alternatives (OR). Scheme names are checked by type; scopes are checked by diagnostics.
 *
 * @typeParam SchemeSet - The schemes whose names a requirement may use.
 */
// `[keyof SchemeSet] extends [never]` asks "are there no schemes?" without distributing over the
// union of names; with no schemes, only `security: []` is valid.
export type Requirement<SchemeSet extends Schemes> = [keyof SchemeSet] extends [never]
  ? Readonly<Record<string, never>>
  : { readonly [Name in keyof SchemeSet]?: readonly string[] };

/** Declares the security schemes of an API. */
export function defineSecurity<const SchemeSet extends Schemes>(
  schemes: SchemeSet,
): Security<SchemeSet> {
  return Object.freeze({ kind: "hyapi.security", schemes });
}

/** An HTTP bearer scheme (`Authorization: Bearer <token>`). */
export function httpBearer<Identity>(
  options: { readonly bearerFormat?: string; readonly description?: string } = {},
): Scheme<Identity> {
  const spec: SchemeSpec = { type: "http", scheme: "bearer", ...options };
  return Object.freeze({ spec });
}

/** An HTTP basic scheme (`Authorization: Basic <credentials>`). */
export function httpBasic<Identity>(
  options: { readonly description?: string } = {},
): BasicScheme<Identity> {
  const spec: BasicSpec = { type: "http", scheme: "basic", ...options };
  return Object.freeze({ spec });
}

/** An API key in a header, query parameter, or cookie. */
export function apiKey<Identity>(options: {
  readonly in: "header" | "query" | "cookie";
  readonly name: string;
  readonly description?: string;
}): Scheme<Identity> {
  const spec: SchemeSpec = { type: "apiKey", ...options };
  return Object.freeze({ spec });
}

/** An OAuth 2 scheme. Its access token is presented as a bearer token. */
export function oauth2<Identity>(options: {
  readonly flows: OAuthFlows;
  readonly description?: string;
}): Scheme<Identity> {
  const spec: SchemeSpec = { type: "oauth2", ...options };
  return Object.freeze({ spec });
}

/** An OpenID Connect scheme. Its ID or access token is presented as a bearer token. */
export function openIdConnect<Identity>(options: {
  readonly url: string;
  readonly description?: string;
}): Scheme<Identity> {
  const { url, ...rest } = options;
  const spec: SchemeSpec = { type: "openIdConnect", openIdConnectUrl: url, ...rest };
  return Object.freeze({ spec });
}
