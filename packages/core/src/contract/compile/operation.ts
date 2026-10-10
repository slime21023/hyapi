// One operation: its method and path, and the parts normalized by the other compile modules.
import type { HttpMethod } from "../../base/http.ts";
import { isRecord } from "../../base/typebox.ts";
import type { AnyContract, OperationSpec } from "../declare/contract.ts";
import type { OperationModel, RequirementModel } from "../model.ts";
import { normalizeBody } from "./body.ts";
import type { OperationContext } from "./context.ts";
import { normalizeParameters } from "./parameters.ts";
import { normalizeResponses } from "./responses.ts";
import { effectiveSecurity } from "./security.ts";

const METHODS: ReadonlySet<string> = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses a path template into its parameter names. */
function parsePath(path: unknown): { params: string[] } | { error: string } {
  if (typeof path !== "string" || !path.startsWith("/")) {
    return { error: "the path must be a string that starts with '/'" };
  }
  if (/[?#]/.test(path)) return { error: "the path must not contain a query string or fragment" };
  const params: string[] = [];
  for (const match of path.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1]!;
    if (!PARAMETER_NAME.test(name)) {
      return { error: `path parameter '{${name}}' must be an identifier` };
    }
    if (params.includes(name)) return { error: `path parameter '{${name}}' appears twice` };
    params.push(name);
  }
  if (/[{}]/.test(path.replace(/\{[^{}]*\}/g, ""))) {
    return { error: "the path has unbalanced braces" };
  }
  return { params };
}

/** Normalizes one operation; undefined when it is not even an object. */
export function normalizeOperation(
  operationId: string,
  op: OperationSpec,
  contractIndex: number,
  contract: AnyContract,
  contractSecurity: RequirementModel[] | undefined,
  ctx: OperationContext,
): OperationModel | undefined {
  const { report } = ctx;
  if (!isRecord(op)) {
    report.error("invalid-api", "an operation must be an object", operationId, operationId);
    return undefined;
  }
  if (!METHODS.has(op.method)) {
    report.error(
      "invalid-method",
      `'${String(op.method)}' is not an HTTP method`,
      operationId,
      `${operationId}/method`,
    );
  }
  const parsed = parsePath(op.path);
  if ("error" in parsed) {
    report.error("invalid-path", parsed.error, operationId, `${operationId}/path`);
  }
  const pathParameters = "params" in parsed ? parsed.params : [];
  const parameters = normalizeParameters(operationId, op, pathParameters, ctx);
  const body = normalizeBody(operationId, op, ctx);
  const responses = normalizeResponses(operationId, op, ctx);

  const { security, origin } = effectiveSecurity(
    op.security,
    { contract: contractSecurity, api: ctx.rootSecurity },
    ctx.schemes,
    report,
    operationId,
  );

  return {
    operationId,
    method: op.method,
    path: typeof op.path === "string" ? op.path : "",
    pathParameters,
    parameters,
    ...(body === undefined ? {} : { body }),
    responses,
    security,
    securityOrigin: origin,
    tags: [...(op.tags ?? contract.tags ?? [])],
    ...(op.summary === undefined ? {} : { summary: op.summary }),
    ...(op.description === undefined ? {} : { description: op.description }),
    deprecated: op.deprecated === true,
    contract: contractIndex,
  };
}
