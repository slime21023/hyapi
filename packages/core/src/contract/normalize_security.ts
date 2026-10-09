import type { Reporter } from "./diagnostics.ts";
import { isRecord } from "./inspect.ts";
import type { RequirementModel } from "./model.ts";
import type { OAuthFlows, Schemes, SchemeSpec } from "./security.ts";

/** Reports the URLs that each OAuth 2 flow of a scheme needs. */
function checkOAuthFlows(
  name: string,
  flows: OAuthFlows,
  invalid: (message: string) => void,
): void {
  const entries = Object.entries(flows);
  if (entries.length === 0) invalid(`OAuth 2 scheme '${name}' needs at least one flow`);
  for (const [flow, value] of entries) {
    const needsAuthorization = flow === "implicit" || flow === "authorizationCode";
    const needsToken = flow !== "implicit";
    if (needsAuthorization && !value?.authorizationUrl) {
      invalid(`OAuth 2 flow '${flow}' of scheme '${name}' needs an authorizationUrl`);
    }
    if (needsToken && !value?.tokenUrl) {
      invalid(`OAuth 2 flow '${flow}' of scheme '${name}' needs a tokenUrl`);
    }
  }
}

/** Reports the fields that one scheme's type requires. */
function checkScheme(name: string, spec: SchemeSpec, report: Reporter): void {
  const invalid = (message: string) =>
    report.error("invalid-security-scheme", message, undefined, `securitySchemes/${name}`);
  if (spec.type === "apiKey" && (typeof spec.name !== "string" || spec.name === "")) {
    invalid(`API key scheme '${name}' needs a non-empty parameter name`);
  }
  if (spec.type === "openIdConnect" && !spec.openIdConnectUrl) {
    invalid(`OpenID Connect scheme '${name}' needs a discovery URL`);
  }
  if (spec.type === "oauth2") checkOAuthFlows(name, spec.flows ?? {}, invalid);
}

/** Checks the declared security schemes; returns the usable ones in declaration order. */
export function normalizeSchemes(
  schemes: Schemes | undefined,
  report: Reporter,
): ReadonlyMap<string, SchemeSpec> {
  const specs = new Map<string, SchemeSpec>();
  for (const [name, scheme] of Object.entries(schemes ?? {})) {
    const spec = scheme?.spec;
    if (!isRecord(spec)) {
      report.error(
        "invalid-security-scheme",
        `security scheme '${name}' must be created with a scheme constructor`,
        undefined,
        `securitySchemes/${name}`,
      );
      continue;
    }
    checkScheme(name, spec as SchemeSpec, report);
    specs.set(name, spec as SchemeSpec);
  }
  return specs;
}

function declaredScopes(spec: SchemeSpec): ReadonlySet<string> | undefined {
  return spec.type === "oauth2"
    ? new Set(Object.values(spec.flows).flatMap((flow) => Object.keys(flow?.scopes ?? {})))
    : undefined;
}

/** Normalizes one `scheme: scopes` entry of a requirement. */
function normalizeEntry(
  scheme: string,
  scopes: unknown,
  schemes: ReadonlyMap<string, SchemeSpec>,
  report: Reporter,
  operationId: string | undefined,
  at: string,
): RequirementModel[number] {
  const list = Array.isArray(scopes) ? scopes.map(String) : [];
  const spec = schemes.get(scheme);
  if (spec === undefined) {
    report.error(
      "unknown-security-scheme",
      `security scheme '${scheme}' is not declared in defineSecurity`,
      operationId,
      at,
    );
    return { scheme, scopes: list };
  }
  // Only OAuth 2 declares its scopes; other schemes accept any scope names (RFC 0001 A3).
  const declared = declaredScopes(spec);
  for (const scope of list.filter((scope) => declared !== undefined && !declared.has(scope))) {
    report.error(
      "undeclared-scope",
      `scope '${scope}' is not declared by any flow of OAuth 2 scheme '${scheme}'`,
      operationId,
      at,
    );
  }
  return { scheme, scopes: list };
}

/** Normalizes one alternative: every scheme in it must succeed. */
function normalizeAlternative(
  requirement: unknown,
  schemes: ReadonlyMap<string, SchemeSpec>,
  report: Reporter,
  operationId: string | undefined,
  at: string,
): RequirementModel {
  const entries = isRecord(requirement) ? Object.entries(requirement) : [];
  if (entries.length === 0) {
    report.error(
      "empty-security-requirement",
      "a security requirement must name at least one scheme; use 'security: []' for a " +
        "public operation",
      operationId,
      at,
    );
  }
  return entries.map(([scheme, scopes]) =>
    normalizeEntry(scheme, scopes, schemes, report, operationId, `${at}/${scheme}`)
  );
}

/** Normalizes a list of alternative requirements against the declared schemes. */
export function normalizeRequirements(
  requirements: unknown,
  schemes: ReadonlyMap<string, SchemeSpec>,
  report: Reporter,
  operationId: string | undefined,
  at: string,
): RequirementModel[] {
  if (!Array.isArray(requirements)) {
    report.error(
      "empty-security-requirement",
      "security must be a list of requirements",
      operationId,
      at,
    );
    return [];
  }
  return requirements.map((requirement, i) =>
    normalizeAlternative(requirement, schemes, report, operationId, `${at}/${i}`)
  );
}
