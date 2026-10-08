import type { RequirementModel, SecuritySchemeModel } from "../contract/model.ts";
import type {
  BasicCredential,
  CredentialOf,
  IdentityOf,
  Schemes,
  Security,
} from "../contract/security.ts";
import { problemResponse } from "./problem.ts";
import { parseCookies } from "./wire.ts";

type Awaitable<T> = T | Promise<T>;

/** What a verifier receives besides the credential. */
export interface VerifierContext {
  /** Aborts on client disconnect, request timeout, or shutdown. */
  readonly signal: AbortSignal;
  readonly request: Request;
  readonly operationId: string;
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
export type VerifierFor<S> = (
  credential: CredentialOf<S>,
  ctx: VerifierContext,
) => Awaitable<Verified<IdentityOf<S>> | null>;

/** The verifier type for scheme `K` of a `defineSecurity` module. */
export type Verifier<Sec extends Security, K extends keyof Sec["schemes"]> = VerifierFor<
  Sec["schemes"][K]
>;

/** One verifier per scheme, as required by `createApp`. */
export type Verifiers<S extends Schemes> = { readonly [K in keyof S]: VerifierFor<S[K]> };

// deno-lint-ignore no-explicit-any
type AnyVerifier = (credential: any, ctx: VerifierContext) => unknown;

type Outcome =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "verified"; readonly identity: unknown; readonly scopes: ReadonlySet<string> };

/** The result of evaluating an operation's security. */
export type SecurityResult =
  | { readonly kind: "allowed"; readonly security: Readonly<Record<string, unknown>> }
  | { readonly kind: "denied"; readonly response: Response };

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
  return undefined;
}

/** Prepares security evaluation for the schemes and verifiers of an application. */
export function createSecurity(
  schemes: readonly SecuritySchemeModel[],
  verifiers: Readonly<Record<string, AnyVerifier>>,
  realm: string,
) {
  const specs = new Map(schemes.map((scheme) => [scheme.name, scheme.spec]));

  return async function evaluate(
    requirements: readonly RequirementModel[],
    request: Request,
    url: URL,
    ctx: VerifierContext,
  ): Promise<SecurityResult> {
    // Each scheme is verified at most once per request, even if several alternatives use it.
    const outcomes = new Map<string, Promise<Outcome>>();
    const verify = (scheme: string): Promise<Outcome> => {
      let outcome = outcomes.get(scheme);
      if (outcome === undefined) {
        outcome = (async (): Promise<Outcome> => {
          const credential = extract(specs.get(scheme)!, request, url);
          if (credential === undefined) return { kind: "missing" };
          if (credential === null) return { kind: "invalid" };
          const result = await verifiers[scheme]!(credential, ctx) as
            | Verified<unknown>
            | null
            | undefined;
          if (result === null || result === undefined) return { kind: "invalid" };
          if (typeof result !== "object" || !("identity" in result)) {
            throw new TypeError(
              `the '${scheme}' verifier must return { identity, scopes? } or null`,
            );
          }
          const scopes = Array.isArray(result.scopes) ? result.scopes.map(String) : [];
          return { kind: "verified", identity: result.identity, scopes: new Set(scopes) };
        })();
        outcomes.set(scheme, outcome);
      }
      return outcome;
    };

    let insufficient: { scheme: string; scopes: readonly string[] } | undefined;
    for (const requirement of requirements) {
      const identities: Record<string, unknown> = {};
      let satisfied = true;
      // AND: in declaration order, stopping at the first failure.
      for (const { scheme, scopes } of requirement) {
        const outcome = await verify(scheme);
        if (outcome.kind !== "verified") {
          satisfied = false;
          break;
        }
        if (!scopes.every((scope) => outcome.scopes.has(scope))) {
          insufficient ??= { scheme, scopes };
          satisfied = false;
          break;
        }
        identities[scheme] = outcome.identity;
      }
      if (satisfied) return { kind: "allowed", security: Object.freeze(identities) };
    }

    // No alternative succeeded. A credential that verified but lacked scopes is 403; otherwise 401.
    if (insufficient !== undefined) {
      const header = challenge(specs.get(insufficient.scheme)!, realm, insufficient.scopes);
      return {
        kind: "denied",
        response: problemResponse(403, "FORBIDDEN", {
          detail: "The credentials do not grant the scopes this operation requires.",
          ...(header === undefined ? {} : { headers: { "www-authenticate": header } }),
        }),
      };
    }
    const challenges = [
      ...new Set(
        requirements.flat().map(({ scheme }) => challenge(specs.get(scheme)!, realm))
          .filter((value): value is string => value !== undefined),
      ),
    ];
    return {
      kind: "denied",
      response: problemResponse(401, "UNAUTHORIZED", {
        detail: "The request lacks valid credentials for this operation.",
        ...(challenges.length === 0
          ? {}
          : { headers: { "www-authenticate": challenges.join(", ") } }),
      }),
    };
  };
}

export type SecurityEvaluator = ReturnType<typeof createSecurity>;
