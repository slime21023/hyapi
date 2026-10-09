import type { RequirementModel, SecuritySchemeModel } from "../contract/model.ts";
import type {
  BasicCredential,
  CredentialOf,
  IdentityOf,
  Schemes,
  Security,
} from "../contract/security.ts";
import { parseCookies } from "./params.ts";

/** What a verifier receives besides the credential. */
export interface VerifierContext {
  /** Aborts on client disconnect, request timeout, or shutdown. */
  readonly signal: AbortSignal;
  readonly request: Request;
  readonly operationId: string;
  /**
   * The operation's effective requirement in OpenAPI form: alternatives, each mapping scheme
   * names to the scopes it requires.
   */
  readonly requirements: readonly Readonly<Record<string, readonly string[]>>[];
  /** The request ID, when `createApp({ requestId })` is on. */
  readonly requestId: string | undefined;
}

/** A successful verification: the identity and the scopes it grants. */
export interface Verified<Identity> {
  readonly identity: Identity;
  /** Scopes granted to the identity. Defaults to none. */
  readonly scopes?: readonly string[];
}

/**
 * Verifies the credential of one security scheme. Returns the identity when the credential is
 * valid and `null` when it is not (401). A thrown error is an internal failure (500), for
 * example an unreachable key server.
 */
type VerifierFor<SchemeType> = (
  credential: CredentialOf<SchemeType>,
  ctx: VerifierContext,
) =>
  | Verified<IdentityOf<SchemeType>>
  | null
  | Promise<Verified<IdentityOf<SchemeType>> | null>;

/**
 * The verifier of one scheme of a `defineSecurity` module.
 *
 * @typeParam Module - The security module, as `typeof security`.
 * @typeParam SchemeName - The scheme's name in that module.
 *
 * @example
 * ```ts
 * const partner: Verifier<typeof security, "partner"> = async (key, ctx) => { ... };
 * ```
 */
export type Verifier<Module extends Security, SchemeName extends keyof Module["schemes"]> =
  VerifierFor<Module["schemes"][SchemeName]>;

/**
 * One verifier per scheme, as required by `createApp`.
 *
 * @typeParam SchemeSet - The API's security schemes, by name.
 */
export type Verifiers<SchemeSet extends Schemes> = {
  readonly [Name in keyof SchemeSet]: VerifierFor<SchemeSet[Name]>;
};

// deno-lint-ignore no-explicit-any
type AnyVerifier = (credential: any, ctx: VerifierContext) => unknown;

type Outcome =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "verified"; readonly identity: unknown; readonly scopes: ReadonlySet<string> };

/** Why no alternative of an operation's security requirement was satisfied. */
export interface Denial {
  /** 401 when no credential verified; 403 when one verified but lacked a required scope. */
  readonly status: 401 | 403;
  readonly reason: "missing" | "invalid" | "insufficient-scope";
  /** `WWW-Authenticate` challenges, in scheme order; possibly empty. */
  readonly challenges: readonly string[];
  /** The schemes the operation accepts, in declaration order. */
  readonly schemes: readonly string[];
  /** For `insufficient-scope`: the scopes the failing alternative requires. */
  readonly requiredScopes?: readonly string[];
}

/** The result of evaluating an operation's security. */
export type SecurityResult =
  | { readonly kind: "allowed"; readonly security: Readonly<Record<string, unknown>> }
  | { readonly kind: "denied"; readonly denial: Denial };

const BEARER = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;
const BASIC = /^Basic[ \t]+([A-Za-z0-9+/=]+)[ \t]*$/i;

function usesBearer(spec: SecuritySchemeModel["spec"]): boolean {
  return (spec.type === "http" && spec.scheme === "bearer") || spec.type === "oauth2" ||
    spec.type === "openIdConnect";
}

function decodeBasic(encoded: string): BasicCredential | undefined {
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const separator = text.indexOf(":");
    if (separator < 0) return undefined;
    return { username: text.slice(0, separator), password: text.slice(separator + 1) };
  } catch {
    return undefined;
  }
}

/** Extracts the credential a scheme defines; `undefined` when absent, `null` when malformed. */
function extract(
  spec: SecuritySchemeModel["spec"],
  request: Request,
  url: URL,
): unknown | null | undefined {
  if (spec.type === "apiKey") {
    const value = spec.in === "header"
      ? request.headers.get(spec.name)
      : spec.in === "query"
      ? url.searchParams.get(spec.name)
      : parseCookies(request.headers.get("cookie")).get(spec.name);
    return value === null || value === undefined || value === "" ? undefined : value;
  }
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  if (usesBearer(spec)) {
    const match = BEARER.exec(authorization);
    // Another authentication scheme in the header means this scheme's credential is absent.
    if (match === null) return /^Bearer\b/i.test(authorization) ? null : undefined;
    return match[1];
  }
  const match = BASIC.exec(authorization);
  if (match === null) return /^Basic\b/i.test(authorization) ? null : undefined;
  return decodeBasic(match[1]!) ?? null;
}

function challenge(spec: SecuritySchemeModel["spec"], realm: string, scopes?: readonly string[]) {
  if (usesBearer(spec)) {
    return scopes === undefined
      ? "Bearer"
      : `Bearer error="insufficient_scope", scope="${scopes.join(" ")}"`;
  }
  if (spec.type === "http" && spec.scheme === "basic") {
    return `Basic realm="${realm.replaceAll('"', "'")}", charset="UTF-8"`;
  }
  // API keys have no registered scheme; this challenge still tells clients where the key goes.
  if (spec.type === "apiKey" && scopes === undefined) {
    return `ApiKey in="${spec.in}", name="${spec.name}"`;
  }
  return undefined;
}

/** The schemes and verifiers of an application, prepared once. */
interface SecurityConfig {
  readonly specs: ReadonlyMap<string, SecuritySchemeModel["spec"]>;
  readonly verifiers: Readonly<Record<string, AnyVerifier>>;
  /** The API title, used as the `Basic` realm. */
  readonly realm: string;
}

/** One request's credentials, verified at most once per scheme. */
interface Attempt {
  readonly config: SecurityConfig;
  readonly request: Request;
  readonly url: URL;
  readonly ctx: VerifierContext;
  readonly outcomes: Map<string, Promise<Outcome>>;
}

/** Extracts and verifies one scheme's credential. */
async function verifyScheme(scheme: string, attempt: Attempt): Promise<Outcome> {
  const { config, request, url, ctx } = attempt;
  const credential = extract(config.specs.get(scheme)!, request, url);
  if (credential === undefined) return { kind: "missing" };
  if (credential === null) return { kind: "invalid" };
  const result = await config.verifiers[scheme]!(credential, ctx) as
    | Verified<unknown>
    | null
    | undefined;
  if (result === null || result === undefined) return { kind: "invalid" };
  if (typeof result !== "object" || !("identity" in result)) {
    throw new TypeError(`the '${scheme}' verifier must return { identity, scopes? } or null`);
  }
  const scopes = Array.isArray(result.scopes) ? result.scopes.map(String) : [];
  return { kind: "verified", identity: result.identity, scopes: new Set(scopes) };
}

/** Verifies a scheme once per request, even if several alternatives use it. */
function verifyOnce(scheme: string, attempt: Attempt): Promise<Outcome> {
  let outcome = attempt.outcomes.get(scheme);
  if (outcome === undefined) {
    outcome = verifyScheme(scheme, attempt);
    attempt.outcomes.set(scheme, outcome);
  }
  return outcome;
}

/** The result of one alternative: satisfied with identities, or why it failed. */
type AlternativeResult =
  | { readonly kind: "satisfied"; readonly identities: Readonly<Record<string, unknown>> }
  | { readonly kind: "failed"; readonly invalid: boolean }
  | { readonly kind: "insufficient"; readonly scheme: string; readonly scopes: readonly string[] };

/** Checks every scheme of one alternative (AND), in order, stopping at the first failure. */
async function checkAlternative(
  requirement: RequirementModel,
  attempt: Attempt,
): Promise<AlternativeResult> {
  const identities: Record<string, unknown> = {};
  for (const { scheme, scopes } of requirement) {
    const outcome = await verifyOnce(scheme, attempt);
    if (outcome.kind !== "verified") return { kind: "failed", invalid: outcome.kind === "invalid" };
    if (!scopes.every((scope) => outcome.scopes.has(scope))) {
      return { kind: "insufficient", scheme, scopes };
    }
    identities[scheme] = outcome.identity;
  }
  return { kind: "satisfied", identities: Object.freeze(identities) };
}

/** Why no alternative succeeded: 403 when a credential lacked scopes, otherwise 401. */
function deny(
  requirements: readonly RequirementModel[],
  insufficient: { scheme: string; scopes: readonly string[] } | undefined,
  invalid: boolean,
  config: SecurityConfig,
): SecurityResult {
  const { specs, realm } = config;
  const schemes = [...new Set(requirements.flat().map(({ scheme }) => scheme))];
  if (insufficient !== undefined) {
    const header = challenge(specs.get(insufficient.scheme)!, realm, insufficient.scopes);
    return {
      kind: "denied",
      denial: {
        status: 403,
        reason: "insufficient-scope",
        challenges: header === undefined ? [] : [header],
        schemes,
        requiredScopes: insufficient.scopes,
      },
    };
  }
  const challenges = schemes.map((scheme) => challenge(specs.get(scheme)!, realm))
    .filter((value): value is string => value !== undefined);
  return {
    kind: "denied",
    denial: { status: 401, reason: invalid ? "invalid" : "missing", challenges, schemes },
  };
}

/** Tries the alternatives (OR) in order; the first satisfied one wins. */
async function evaluate(
  requirements: readonly RequirementModel[],
  attempt: Attempt,
): Promise<SecurityResult> {
  let insufficient: { scheme: string; scopes: readonly string[] } | undefined;
  let invalid = false;
  for (const requirement of requirements) {
    const result = await checkAlternative(requirement, attempt);
    if (result.kind === "satisfied") return { kind: "allowed", security: result.identities };
    if (result.kind === "failed") invalid ||= result.invalid;
    else insufficient ??= { scheme: result.scheme, scopes: result.scopes };
  }
  return deny(requirements, insufficient, invalid, attempt.config);
}

/** Prepares security evaluation for the schemes and verifiers of an application. */
export function createSecurity(
  schemes: readonly SecuritySchemeModel[],
  verifiers: Readonly<Record<string, AnyVerifier>>,
  realm: string,
) {
  const config: SecurityConfig = {
    specs: new Map(schemes.map((scheme) => [scheme.name, scheme.spec])),
    verifiers,
    realm,
  };
  return (
    requirements: readonly RequirementModel[],
    request: Request,
    url: URL,
    ctx: VerifierContext,
  ): Promise<SecurityResult> =>
    evaluate(requirements, { config, request, url, ctx, outcomes: new Map() });
}

export type SecurityEvaluator = ReturnType<typeof createSecurity>;
