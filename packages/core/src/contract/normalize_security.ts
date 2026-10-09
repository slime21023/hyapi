import type { Reporter } from "./diagnostics.ts";
import { isRecord } from "./inspect.ts";
import type { RequirementModel } from "./model.ts";
import type { Schemes, SchemeSpec } from "./security.ts";

/** Checks the declared security schemes; returns the usable ones in declaration order. */
export function normalizeSchemes(
  schemes: Schemes | undefined,
  report: Reporter,
): ReadonlyMap<string, SchemeSpec> {
  const specs = new Map<string, SchemeSpec>();
  for (const [name, scheme] of Object.entries(schemes ?? {})) {
    const spec = scheme?.spec;
    const at = `securitySchemes/${name}`;
    const invalid = (message: string) =>
      report.error("invalid-security-scheme", message, undefined, at);
    if (!isRecord(spec)) {
      invalid(`security scheme '${name}' must be created with a scheme constructor`);
      continue;
    }
    if (spec.type === "apiKey" && (typeof spec.name !== "string" || spec.name === "")) {
      invalid(`API key scheme '${name}' needs a non-empty parameter name`);
    }
    if (spec.type === "openIdConnect" && !spec.openIdConnectUrl) {
      invalid(`OpenID Connect scheme '${name}' needs a discovery URL`);
    }
    if (spec.type === "oauth2") {
      const flows = Object.entries(spec.flows ?? {});
      if (flows.length === 0) invalid(`OAuth 2 scheme '${name}' needs at least one flow`);
      for (const [flow, value] of flows) {
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
    specs.set(name, spec as SchemeSpec);
  }
  return specs;
}

function declaredScopes(spec: SchemeSpec): ReadonlySet<string> | undefined {
  return spec.type === "oauth2"
    ? new Set(Object.values(spec.flows).flatMap((flow) => Object.keys(flow?.scopes ?? {})))
    : undefined;
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
  return requirements.map((requirement, i) => {
    const entries = isRecord(requirement) ? Object.entries(requirement) : [];
    if (entries.length === 0) {
      report.error(
        "empty-security-requirement",
        "a security requirement must name at least one scheme; use 'security: []' for a " +
          "public operation",
        operationId,
        `${at}/${i}`,
      );
    }
    return entries.map(([scheme, scopes]) => {
      const spec = schemes.get(scheme);
      const list = Array.isArray(scopes) ? scopes.map(String) : [];
      if (spec === undefined) {
        report.error(
          "unknown-security-scheme",
          `security scheme '${scheme}' is not declared in defineSecurity`,
          operationId,
          `${at}/${i}/${scheme}`,
        );
      } else {
        const declared = declaredScopes(spec);
        for (const scope of declared ? list : []) {
          if (!declared!.has(scope)) {
            report.error(
              "undeclared-scope",
              `scope '${scope}' is not declared by any flow of OAuth 2 scheme '${scheme}'`,
              operationId,
              `${at}/${i}/${scheme}`,
            );
          }
        }
      }
      return { scheme, scopes: list };
    });
  });
}
