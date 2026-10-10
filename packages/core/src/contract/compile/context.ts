// What every operation is normalized against. It lives apart from operation.ts so that the modules
// operation.ts calls (parameters, body, responses) can take it without importing their caller.
import type { RequirementModel, SchemeSpec } from "../model.ts";
import type { Components } from "./components.ts";
import type { Reporter } from "./diagnostics.ts";
import type { Inspector } from "./schema_rules.ts";

/** Everything an operation is normalized against. */
export interface OperationContext {
  readonly report: Reporter;
  readonly inspector: Inspector;
  readonly schemes: ReadonlyMap<string, SchemeSpec>;
  readonly components: Components;
  readonly rootSecurity: RequirementModel[] | undefined;
}
