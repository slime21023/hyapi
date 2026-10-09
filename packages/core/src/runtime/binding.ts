import type { AnyContract } from "../contract/define.ts";
import type { ContractModel, OperationModel } from "../contract/model.ts";
import type { Implementation } from "./handler.ts";
import type { LifecycleResource } from "./lifecycle.ts";

/** Stable identifiers for diagnostics that only `createApp` can report. */
export type StartupDiagnosticCode =
  | "invalid-option"
  | "invalid-lifecycle"
  | "unknown-implementation"
  | "duplicate-implementation"
  | "missing-implementation"
  | "missing-handler"
  | "invalid-handler"
  | "unknown-handler"
  | "unknown-timeout-target"
  | "missing-verifier"
  | "invalid-verifier"
  | "unknown-verifier"
  | "document-route-conflict"
  | "format-conflict"
  | "not-implemented";

/** Reports a startup error. */
export type StartupReport = (
  code: StartupDiagnosticCode,
  message: string,
  operationId?: string,
) => void;

// deno-lint-ignore no-explicit-any
type AnyHandler = (input: any, ctx: any) => unknown;

/** An operation bound to its handler, or to none when it is `notImplemented`. */
export interface Binding {
  readonly operation: OperationModel;
  readonly handler: AnyHandler | undefined;
  readonly timeoutMs: number;
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Checks lifecycle resources: named, unique, and with functions for `start` and `stop`. */
export function checkLifecycle(
  resources: readonly LifecycleResource[],
  error: StartupReport,
): void {
  const names = new Set<string>();
  for (const resource of resources) {
    if (typeof resource?.name !== "string" || resource.name === "") {
      error("invalid-lifecycle", "every lifecycle resource needs a non-empty name");
    } else if (names.has(resource.name)) {
      error("invalid-lifecycle", `lifecycle resource '${resource.name}' is listed twice`);
    } else names.add(resource.name);
    const invalid = (["start", "stop"] as const).filter((phase) =>
      resource?.[phase] !== undefined && typeof resource[phase] !== "function"
    );
    for (const phase of invalid) {
      error("invalid-lifecycle", `'${resource.name}' ${phase} must be a function`);
    }
  }
}

/**
 * Binds every operation to the handler of its contract's implementation, with its timeout.
 * Reports missing, duplicate, unknown, and invalid implementations, handlers, and timeouts.
 */
export function bindOperations(
  model: ContractModel,
  contracts: readonly AnyContract[],
  implementations: readonly Implementation[],
  timeouts: Readonly<Record<string, unknown>>,
  requestTimeoutMs: number,
  error: StartupReport,
): Binding[] {
  const byContract = new Map<AnyContract, Implementation>();
  for (const implementation of implementations) {
    if (!contracts.includes(implementation?.contract)) {
      error(
        "unknown-implementation",
        "an implementation is bound to a contract that the API does not list",
      );
    } else if (byContract.has(implementation.contract)) {
      error(
        "duplicate-implementation",
        `contract ${contracts.indexOf(implementation.contract)} is implemented twice`,
      );
    } else byContract.set(implementation.contract, implementation);
  }
  contracts.forEach((contract, index) => {
    if (!byContract.has(contract)) {
      error(
        "missing-implementation",
        `contract ${index} has no implementation; pass implement(contract, handlers)`,
      );
    }
  });

  const operationIds = new Set(model.operations.map((operation) => operation.operationId));
  for (const [operationId, value] of Object.entries(timeouts)) {
    if (!operationIds.has(operationId)) {
      error("unknown-timeout-target", `'${operationId}' is not an operation of the API`);
    } else if (value !== undefined && !positiveInteger(value)) {
      error("invalid-option", `the timeout of '${operationId}' must be a positive integer`);
    }
  }

  const bindings: Binding[] = [];
  for (const operation of model.operations) {
    const implementation = byContract.get(contracts[operation.contract]!);
    if (implementation === undefined) continue;
    const handler = implementation.handlers[operation.operationId];
    const isNotImplemented = typeof handler === "object" && handler !== null &&
      (handler as { kind?: unknown }).kind === "hyapi.not-implemented";
    if (handler === undefined) {
      error(
        "missing-handler",
        "the operation has no handler; implement it or use notImplemented",
        operation.operationId,
      );
      continue;
    }
    if (!isNotImplemented && typeof handler !== "function") {
      error(
        "invalid-handler",
        "a handler must be a function or notImplemented",
        operation.operationId,
      );
      continue;
    }
    const timeout = timeouts[operation.operationId];
    bindings.push({
      operation,
      handler: isNotImplemented ? undefined : handler as AnyHandler,
      timeoutMs: positiveInteger(timeout) ? timeout : requestTimeoutMs,
    });
  }
  for (const implementation of byContract.values()) checkHandlerNames(implementation, error);
  return bindings;
}

/** Reports handlers whose names are not operations of the implemented contract. */
function checkHandlerNames(implementation: Implementation, error: StartupReport): void {
  const declared = new Set(Object.keys(implementation.contract.operations));
  for (const name of Object.keys(implementation.handlers)) {
    if (!declared.has(name)) {
      error("unknown-handler", `'${name}' is not an operation of its contract`, name);
    }
  }
}

/** Checks that there is exactly one verifier function per declared security scheme. */
export function checkVerifiers(
  model: ContractModel,
  verifiers: Readonly<Record<string, unknown>>,
  error: StartupReport,
): void {
  const schemeNames = new Set(model.securitySchemes.map((scheme) => scheme.name));
  for (const name of schemeNames) {
    if (verifiers[name] === undefined) {
      error(
        "missing-verifier",
        `security scheme '${name}' has no verifier; pass verifiers.${name}`,
      );
    } else if (typeof verifiers[name] !== "function") {
      error("invalid-verifier", `the verifier for '${name}' must be a function`);
    }
  }
  for (const name of Object.keys(verifiers)) {
    if (!schemeNames.has(name)) {
      error("unknown-verifier", `'${name}' is not a security scheme declared by defineSecurity`);
    }
  }
}
