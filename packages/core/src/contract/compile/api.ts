// The API as a whole: its metadata, custom formats, and the contracts it merges, with the conflicts
// that only appear across contracts.
import { isRecord } from "../../base/record.ts";
import { ANNOTATION_FORMATS, STANDARD_FORMATS } from "../../base/typebox.ts";
import type { Api } from "../declare/api.ts";
import type { AnyContract, OperationSpec } from "../declare/contract.ts";
import type { FormatModel, OperationModel } from "../model.ts";
import type { Reporter } from "./diagnostics.ts";
import type { OperationContext } from "./context.ts";
import { normalizeOperation } from "./operation.ts";
import { normalizeRequirements } from "./security.ts";

/** Reports API metadata that OpenAPI requires. */
export function checkInfo(api: Api, report: Reporter): void {
  if (typeof api.info?.title !== "string" || api.info.title === "") {
    report.error("invalid-api", "info.title must be a non-empty string", undefined, "info/title");
  }
  if (typeof api.info?.version !== "string" || api.info.version === "") {
    report.error(
      "invalid-api",
      "info.version must be a non-empty string",
      undefined,
      "info/version",
    );
  }
}

/** Checks the custom formats declared with `defineApi({ formats })`. */
export function normalizeFormats(formats: unknown, report: Reporter): FormatModel[] {
  if (formats === undefined) return [];
  if (!isRecord(formats)) {
    report.error(
      "invalid-format",
      "formats must be an object of check functions",
      undefined,
      "formats",
    );
    return [];
  }
  const models: FormatModel[] = [];
  for (const [name, check] of Object.entries(formats)) {
    const at = `formats/${name}`;
    if (STANDARD_FORMATS.has(name) || ANNOTATION_FORMATS.has(name)) {
      report.error(
        "invalid-format",
        `'${name}' is a standard format and cannot be redeclared`,
        undefined,
        at,
      );
    } else if (typeof check !== "function") {
      report.error(
        "invalid-format",
        `the check of format '${name}' must be a function`,
        undefined,
        at,
      );
    } else {
      models.push({ name, check: check as FormatModel["check"] });
    }
  }
  return models;
}

/** Operations collected across contracts, with the owners and routes seen so far. */
interface Collected {
  readonly operations: OperationModel[];
  /** The contract index that declared each `operationId`. */
  readonly owners: Map<string, number>;
  /** The operation that holds each method and path template. */
  readonly routes: Map<string, string>;
}

/** Checks that a listed contract is usable; false when its operations must be skipped. */
function acceptContract(
  api: Api,
  contract: unknown,
  at: string,
  seen: Set<unknown>,
  report: Reporter,
): contract is AnyContract {
  if (!isRecord(contract) || contract.kind !== "hyapi.contract") {
    report.error(
      "invalid-api",
      "every contract must be created with defineContract",
      undefined,
      at,
    );
    return false;
  }
  if (seen.has(contract)) {
    report.error("duplicate-contract", "the same contract is listed twice", undefined, at);
    return false;
  }
  seen.add(contract);
  if (contract.securitySchemes !== undefined && contract.securitySchemes !== api.securitySchemes) {
    report.error(
      "security-schemes-mismatch",
      "the contract uses a different defineSecurity module than defineApi; both must import " +
        "the same value",
      undefined,
      `${at}/securitySchemes`,
    );
  }
  return true;
}

/** Reports an operation whose method and path match the same requests as an earlier one. */
function checkRoute(operation: OperationModel, routes: Map<string, string>, report: Reporter) {
  const route = `${operation.method} ${operation.path.replace(/\{[^{}]*\}/g, "{}")}`;
  const clash = routes.get(route);
  if (clash === undefined) {
    routes.set(route, operation.operationId);
    return;
  }
  report.error(
    "duplicate-route",
    `'${operation.method} ${operation.path}' matches the same requests as operation '${clash}'`,
    operation.operationId,
    `${operation.operationId}/path`,
  );
}

/** Normalizes the operations of one contract into `collected`. */
function normalizeContract(
  contract: AnyContract,
  index: number,
  collected: Collected,
  report: Reporter,
  ctx: OperationContext,
): void {
  const contractSecurity = contract.security === undefined ? undefined : normalizeRequirements(
    contract.security,
    ctx.schemes,
    report,
    undefined,
    `contracts/${index}/security`,
  );
  for (const [operationId, declared] of Object.entries(contract.operations ?? {})) {
    const owner = collected.owners.get(operationId);
    if (owner !== undefined) {
      report.error(
        "duplicate-operation-id",
        `operationId '${operationId}' is declared by contracts ${owner} and ${index}`,
        operationId,
      );
      continue;
    }
    collected.owners.set(operationId, index);
    const operation = normalizeOperation(
      operationId,
      declared as OperationSpec,
      index,
      contract,
      contractSecurity,
      ctx,
    );
    if (operation === undefined) continue;
    checkRoute(operation, collected.routes, report);
    collected.operations.push(operation);
  }
}

/** Normalizes the operations of every listed contract, in contract order. */
export function normalizeContracts(
  api: Api,
  report: Reporter,
  ctx: OperationContext,
): OperationModel[] {
  if (!Array.isArray(api.contracts)) {
    report.error("invalid-api", "contracts must be a list", undefined, "contracts");
    return [];
  }
  const collected: Collected = { operations: [], owners: new Map(), routes: new Map() };
  const seen = new Set<unknown>();
  for (const [index, contract] of (api.contracts as readonly unknown[]).entries()) {
    if (!acceptContract(api, contract, `contracts/${index}`, seen, report)) continue;
    normalizeContract(contract, index, collected, report, ctx);
  }
  return collected.operations;
}
