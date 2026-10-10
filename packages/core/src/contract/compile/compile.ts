// The contract compiler's entry point: the only place where contracts are interpreted (ADR 0002
// §2). The other modules in compile/ are private to it (ADR 0004 §3).
import { isRecord, snapshot } from "../../base/typebox.ts";
import type { Api } from "../declare/api.ts";
import type { ContractModel } from "../model.ts";
import { checkInfo, normalizeContracts, normalizeFormats } from "./api.ts";
import { createComponents } from "./components.ts";
import { createReporter, type Diagnostic } from "./diagnostics.ts";
import type { OperationContext } from "./operation.ts";
import { createInspector } from "./schema_rules.ts";
import { normalizeRequirements, normalizeSchemes } from "./security.ts";

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
  const components = createComponents(report);
  const inspector = createInspector(report, components, new Set(formats.map((f) => f.name)));
  const schemes = normalizeSchemes(api.securitySchemes?.schemes, report);
  const rootSecurity = api.security === undefined
    ? undefined
    : normalizeRequirements(api.security, schemes, report, undefined, "security");
  const ctx: OperationContext = { report, inspector, components, schemes, rootSecurity };
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
    schemas: [...components.schemas].map(([name, schema]) => ({ name, schema })),
    responses: [...components.responses.values()],
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
