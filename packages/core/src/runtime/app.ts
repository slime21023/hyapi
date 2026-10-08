import { checkContracts, type Diagnostic } from "../contract/check.ts";
import type { AnyContract, Api } from "../contract/define.ts";
import type { Schemes } from "../contract/security.ts";
import type { Implementation } from "./handler.ts";
import { execute, type OperationPlan, planOperation, type ResponseValidation } from "./pipeline.ts";
import { describeError, problemResponse } from "./problem.ts";
import { compileRoutes } from "./routing.ts";
import { createSecurity, type Verifiers } from "./security.ts";
import { createValidators } from "./validation.ts";

// deno-lint-ignore no-explicit-any
type SchemesOf<A> = A extends Api<infer S, any> ? S : Schemes;

/** One verifier per security scheme, required when the API declares schemes. */
type VerifierOption<A> = [keyof SchemesOf<A>] extends [never]
  ? { readonly verifiers?: Readonly<Record<string, never>> }
  : { readonly verifiers: Verifiers<SchemesOf<A>> };

/** Options for {@link createApp}. */
export type AppOptions<A extends Api = Api> = BaseOptions<A> & VerifierOption<A>;

interface BaseOptions<A extends Api> {
  /** The API created by `defineApi`. */
  readonly api: A;
  /** Exactly one implementation per contract of the API, created by `implement`. */
  readonly implementations: readonly Implementation[];
  /**
   * Development mode adds diagnostic details to error responses and reports stripped response
   * fields. Defaults to `false`.
   */
  readonly development?: boolean;
  /**
   * What happens when a response does not match its schema after undeclared fields are stripped.
   * Defaults to `"enforce"` in development and `"log"` otherwise.
   */
  readonly responseValidation?: ResponseValidation;
  /** Time allowed for a handler before the request fails with 503. Defaults to 30 000 ms. */
  readonly requestTimeoutMs?: number;
  /** Maximum request body size. Defaults to 1 MiB. */
  readonly bodyLimitBytes?: number;
}

/** A running HyAPI application. */
export interface App {
  /** Handles one request. Compatible with `Deno.serve` and any Web-standard host. */
  fetch(request: Request): Promise<Response>;
}

/** A problem that prevents an application from starting. */
export interface StartupDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly operationId?: string;
  readonly location?: string;
}

/** Thrown by {@link createApp} with every diagnostic that prevents startup. */
export class StartupError extends Error {
  readonly diagnostics: readonly StartupDiagnostic[];

  constructor(diagnostics: readonly StartupDiagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === "error");
    super(
      `The application cannot start (${errors.length} error${errors.length === 1 ? "" : "s"}):\n` +
        errors.map((d) => `- [${d.code}]${d.operationId ? ` ${d.operationId}:` : ""} ${d.message}`)
          .join("\n"),
    );
    this.name = "StartupError";
    this.diagnostics = diagnostics;
  }
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Assembles an API and its implementations into an application. Every contract, implementation,
 * and option problem is reported together in a {@link StartupError}.
 */
export function createApp<A extends Api>(options: AppOptions<A>): Promise<App> {
  const development = options.development ?? false;
  const settings = {
    development,
    responseValidation: options.responseValidation ?? (development ? "enforce" : "log"),
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    bodyLimitBytes: options.bodyLimitBytes ?? 1_048_576,
  } as const;

  const diagnostics: StartupDiagnostic[] = [];
  const error = (code: string, message: string, operationId?: string) =>
    diagnostics.push({ severity: "error", code, message, ...(operationId ? { operationId } : {}) });

  if (!["off", "log", "enforce"].includes(settings.responseValidation)) {
    error("invalid-option", "responseValidation must be 'off', 'log', or 'enforce'");
  }
  if (!positiveInteger(settings.requestTimeoutMs)) {
    error("invalid-option", "requestTimeoutMs must be a positive integer");
  }
  if (!positiveInteger(settings.bodyLimitBytes)) {
    error("invalid-option", "bodyLimitBytes must be a positive integer");
  }

  const checked = checkContracts(options.api);
  diagnostics.push(...checked.diagnostics as readonly Diagnostic[]);
  if (!checked.ok) return Promise.reject(new StartupError(diagnostics));
  const { model } = checked;

  // Implementations: exactly one per contract, with one handler per operation.
  const contracts = options.api.contracts as readonly AnyContract[];
  const byContract = new Map<AnyContract, Implementation>();
  for (const implementation of options.implementations) {
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

  const validators = createValidators();
  const plans = new Map<string, OperationPlan>();
  const pending: string[] = [];
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
    if (isNotImplemented) pending.push(operation.operationId);
    plans.set(
      operation.operationId,
      planOperation(operation, isNotImplemented ? undefined : handler as never, validators),
    );
  }
  for (const implementation of byContract.values()) {
    const declared = new Set(Object.keys(implementation.contract.operations));
    for (const name of Object.keys(implementation.handlers)) {
      if (!declared.has(name)) {
        error("unknown-handler", `'${name}' is not an operation of its contract`, name);
      }
    }
  }

  // Verifiers: exactly one function per declared security scheme.
  const verifiers = (options.verifiers ?? {}) as Readonly<Record<string, unknown>>;
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

  if (diagnostics.some((d) => d.severity === "error")) {
    return Promise.reject(new StartupError(diagnostics));
  }
  if (development) {
    for (const d of diagnostics) {
      console.warn(`[hyapi] warning [${d.code}] ${d.operationId ?? ""} ${d.message}`);
    }
    if (pending.length > 0) console.warn(`[hyapi] not implemented: ${pending.join(", ")}`);
  }

  const router = compileRoutes(model.operations);
  const security = createSecurity(
    model.securitySchemes,
    verifiers as Parameters<typeof createSecurity>[1],
    model.info.title,
  );
  const app: App = {
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const match = router.match(request.method, url.pathname);
        switch (match.kind) {
          case "not-found":
            return problemResponse(404, "NOT_FOUND", {
              detail: `No operation matches ${url.pathname}.`,
            });
          case "method-not-allowed":
            return problemResponse(405, "METHOD_NOT_ALLOWED", {
              detail: `${request.method} is not declared for ${url.pathname}.`,
              headers: { allow: match.allow.join(", ") },
            });
          case "malformed-path":
            return problemResponse(400, "MALFORMED_REQUEST", {
              detail: "The path is not valid percent-encoding.",
            });
        }
        const response = await execute(
          plans.get(match.operation.operationId)!,
          request,
          url,
          match.params,
          settings,
          security,
        );
        return match.head
          ? new Response(null, { status: response.status, headers: response.headers })
          : response;
      } catch (caught) {
        return problemResponse(
          500,
          "INTERNAL_ERROR",
          settings.development ? { debug: describeError(caught) } : {},
        );
      }
    },
  };
  return Promise.resolve(Object.freeze(app));
}
