import type { AnyContract, Api, OperationSpec } from "./define.ts";
import { createReporter, type Diagnostic, type Reporter } from "./diagnostics.ts";
import {
  ANNOTATION_FORMATS,
  createInspector,
  type Inspector,
  isRecord,
  STANDARD_FORMATS,
} from "./inspect.ts";
import type { ContractModel, FormatModel, OperationModel } from "./model.ts";
import { normalizeOperation, type OperationContext } from "./normalize_operation.ts";
import { normalizeRequirements, normalizeSchemes } from "./normalize_security.ts";
import { snapshot } from "./snapshot.ts";

/** The result of {@link checkContracts}. */
export interface CheckResult {
  /** True when no diagnostic is an error; warnings never fail the check. */
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/** The normalized model with its diagnostics; internal to `@hyapi/core`. */
export type Compiled =
  | {
    readonly ok: true;
    readonly model: ContractModel;
    readonly diagnostics: readonly Diagnostic[];
  }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

function checkInfo(api: Api, report: Reporter): void {
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

function normalizeFormats(formats: unknown, report: Reporter): FormatModel[] {
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

function normalizeContracts(
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

/**
 * Merges and normalizes an API's contracts into the internal model, reporting every problem
 * together. This is the only place where contracts are interpreted (ADR 0002 §2). The model is a
 * frozen copy, so later changes to the declarations cannot reach it (ADR 0003 §2).
 */
export function compileContracts(api: Api): Compiled {
  const report = createReporter();
  if (!isRecord(api) || api.kind !== "hyapi.api") {
    report.error("invalid-api", "checkContracts expects a value created by defineApi");
    return { ok: false, diagnostics: Object.freeze([...report.diagnostics]) };
  }
  checkInfo(api, report);
  const formats = normalizeFormats(api.formats, report);
  const inspector: Inspector = createInspector(report, new Set(formats.map((f) => f.name)));
  const schemes = normalizeSchemes(api.securitySchemes?.schemes, report);
  const rootSecurity = api.security === undefined
    ? undefined
    : normalizeRequirements(api.security, schemes, report, undefined, "security");
  const ctx: OperationContext = { report, inspector, schemes, responses: new Map(), rootSecurity };
  const operations = normalizeContracts(api, report, ctx);

  const diagnostics = Object.freeze([...report.diagnostics]);
  if (report.hasErrors()) return { ok: false, diagnostics };
  const model: ContractModel = snapshot({
    info: api.info,
    servers: [...(api.servers ?? [])],
    tags: [...(api.tags ?? [])],
    formats,
    securitySchemes: [...schemes].map(([name, spec]) => ({ name, spec })),
    security: rootSecurity,
    operations,
    schemas: [...inspector.schemas].map(([name, schema]) => ({ name, schema })),
    responses: [...ctx.responses.values()].map((entry) => entry.model),
  });
  return { ok: true, model, diagnostics };
}

/**
 * Checks an API's contracts and reports every problem together. The same rules run in
 * `createApp`, `hyapi emit`, and `hyapi doctor`.
 */
export function checkContracts(api: Api): CheckResult {
  const { ok, diagnostics } = compileContracts(api);
  return Object.freeze({ ok, diagnostics });
}
