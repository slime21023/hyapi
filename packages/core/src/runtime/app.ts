import { checkContracts, type Diagnostic } from "../contract/check.ts";
import type { AnyContract, Api, Contract } from "../contract/define.ts";
import type { Schemes } from "../contract/security.ts";
import { createEmitter, type EventListener } from "./events.ts";
import type { Implementation } from "./handler.ts";
import { type Health, markDraining } from "./health.ts";
import { type LifecycleResource, startResources, stopResources } from "./lifecycle.ts";
import { execute, type OperationPlan, planOperation, type ResponseValidation } from "./pipeline.ts";
import { describeError, problemResponse } from "./problem.ts";
import { compileRoutes } from "./routing.ts";
import { createSecurity, type Verifiers } from "./security.ts";
import { createValidators } from "./validation.ts";

// deno-lint-ignore no-explicit-any
type SchemesOf<A> = A extends Api<infer S, any> ? S : Schemes;

/** The `operationId`s of every contract of an API. */
// deno-lint-ignore no-explicit-any
export type OperationIdsOf<A> = A extends Api<any, infer Cs>
  // deno-lint-ignore no-explicit-any
  ? Cs extends readonly (infer C)[] ? C extends Contract<any, infer Ops, any> ? keyof Ops & string
    : never
  : never
  : never;

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
  /** Time allowed per request before it fails with 503. Defaults to 30 000 ms. */
  readonly requestTimeoutMs?: number;
  /** Per-operation request timeouts that override `requestTimeoutMs`. */
  readonly timeouts?: { readonly [K in OperationIdsOf<A>]?: number };
  /** Maximum request body size. Defaults to 1 MiB. */
  readonly bodyLimitBytes?: number;
  /** Resources started in order before the app is returned, and stopped in reverse on close. */
  readonly lifecycle?: readonly LifecycleResource[];
  /** The health aggregator from `createHealth`; it reports unhealthy while the app shuts down. */
  readonly health?: Health;
  /** Receives read-only events. Without it, problem events are written with `console.warn`. */
  readonly onEvent?: EventListener;
  /**
   * Budget for `close()`: draining requests, then stopping lifecycle resources, each gets this
   * long. Defaults to 10 000 ms.
   */
  readonly shutdownTimeoutMs?: number;
  /** Serves an emitted OpenAPI document at an explicit path. Off unless set. */
  readonly document?: { readonly path: string; readonly content: unknown };
}

/** A running HyAPI application. */
export interface App {
  /** Handles one request. Compatible with `Deno.serve` and any Web-standard host. */
  fetch(request: Request): Promise<Response>;
  /**
   * Stops admitting requests (new ones get 503), drains in-flight requests within the shutdown
   * budget, aborts the rest, then stops lifecycle resources in reverse order. Idempotent. Rejects
   * with an `AggregateError` when resources fail to stop.
   */
  close(): Promise<void>;
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

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Assembles an API and its implementations into an application, starts its lifecycle resources,
 * and returns it. Every contract, implementation, and option problem is reported together in a
 * {@link StartupError}.
 */
export async function createApp<A extends Api>(options: AppOptions<A>): Promise<App> {
  const development = options.development ?? false;
  const emit = createEmitter(options.onEvent);
  const settings = {
    development,
    responseValidation: options.responseValidation ?? (development ? "enforce" : "log"),
    bodyLimitBytes: options.bodyLimitBytes ?? 1_048_576,
    emit,
  } as const;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;

  const diagnostics: StartupDiagnostic[] = [];
  const error = (code: string, message: string, operationId?: string) =>
    diagnostics.push({ severity: "error", code, message, ...(operationId ? { operationId } : {}) });

  if (!["off", "log", "enforce"].includes(settings.responseValidation)) {
    error("invalid-option", "responseValidation must be 'off', 'log', or 'enforce'");
  }
  for (
    const [name, value] of [
      ["requestTimeoutMs", requestTimeoutMs],
      ["bodyLimitBytes", settings.bodyLimitBytes],
      ["shutdownTimeoutMs", shutdownTimeoutMs],
    ] as const
  ) {
    if (!positiveInteger(value)) error("invalid-option", `${name} must be a positive integer`);
  }
  const lifecycle = options.lifecycle ?? [];
  const resourceNames = new Set<string>();
  for (const resource of lifecycle) {
    if (typeof resource?.name !== "string" || resource.name === "") {
      error("invalid-lifecycle", "every lifecycle resource needs a non-empty name");
    } else if (resourceNames.has(resource.name)) {
      error("invalid-lifecycle", `lifecycle resource '${resource.name}' is listed twice`);
    } else resourceNames.add(resource.name);
    for (const phase of ["start", "stop"] as const) {
      if (resource?.[phase] !== undefined && typeof resource[phase] !== "function") {
        error("invalid-lifecycle", `'${resource.name}' ${phase} must be a function`);
      }
    }
  }

  const checked = checkContracts(options.api);
  diagnostics.push(...checked.diagnostics as readonly Diagnostic[]);
  if (!checked.ok) throw new StartupError(diagnostics);
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

  // Per-operation timeouts.
  const timeouts = (options.timeouts ?? {}) as Readonly<Record<string, unknown>>;
  const operationIds = new Set(model.operations.map((operation) => operation.operationId));
  for (const [operationId, value] of Object.entries(timeouts)) {
    if (!operationIds.has(operationId)) {
      error("unknown-timeout-target", `'${operationId}' is not an operation of the API`);
    } else if (value !== undefined && !positiveInteger(value)) {
      error("invalid-option", `the timeout of '${operationId}' must be a positive integer`);
    }
  }

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
    const timeout = timeouts[operation.operationId];
    plans.set(
      operation.operationId,
      planOperation(
        operation,
        isNotImplemented ? undefined : handler as never,
        positiveInteger(timeout) ? timeout : requestTimeoutMs,
        validators,
      ),
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

  // The opt-in document endpoint must not shadow a declared route.
  const router = compileRoutes(model.operations);
  const document = options.document;
  let documentBody: { text: string; type: string } | undefined;
  if (document !== undefined) {
    if (typeof document.path !== "string" || !document.path.startsWith("/")) {
      error("invalid-option", "document.path must start with '/'");
    } else if (router.match("GET", document.path).kind !== "not-found") {
      error("document-route-conflict", `document.path '${document.path}' is a declared route`);
    } else {
      const yaml = /\.ya?ml$/i.test(document.path);
      documentBody = typeof document.content === "string"
        ? { text: document.content, type: yaml ? "application/yaml" : "application/json" }
        : { text: JSON.stringify(document.content), type: "application/json" };
    }
  }

  if (diagnostics.some((d) => d.severity === "error")) throw new StartupError(diagnostics);
  for (const d of diagnostics) {
    emit({
      type: "startup.warning",
      code: d.code,
      message: d.message,
      ...(d.operationId === undefined ? {} : { operationId: d.operationId }),
    });
  }
  if (development && pending.length > 0) {
    console.warn(`[hyapi] not implemented: ${pending.join(", ")}`);
  }

  await startResources(lifecycle, shutdownTimeoutMs, emit);

  const security = createSecurity(
    model.securitySchemes,
    verifiers as Parameters<typeof createSecurity>[1],
    model.info.title,
  );
  const shutdown = new AbortController();
  let state: "running" | "closing" | "closed" = "running";
  let inFlight = 0;
  let drained: (() => void) | undefined;
  let closing: Promise<void> | undefined;

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (documentBody !== undefined && url.pathname === document!.path) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return problemResponse(405, "METHOD_NOT_ALLOWED", { headers: { allow: "GET, HEAD" } });
      }
      return new Response(request.method === "HEAD" ? null : documentBody.text, {
        headers: { "content-type": documentBody.type },
      });
    }
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
    const { operation } = match;
    const base = {
      operationId: operation.operationId,
      method: request.method,
      path: operation.path,
      deprecated: operation.deprecated,
    };
    emit({ type: "operation.start", ...base });
    const started = performance.now();
    const outcome = await execute(
      plans.get(operation.operationId)!,
      request,
      url,
      match.params,
      settings,
      security,
      shutdown.signal,
    );
    const { response } = outcome;
    const code = response.headers.get("content-type") === "application/problem+json"
      ? await response.clone().json().then((body) => body?.code, () => undefined)
      : undefined;
    emit({
      type: "operation.end",
      ...base,
      status: response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ...(typeof code === "string" ? { code } : {}),
      ...(outcome.error === undefined ? {} : {
        error: (({ name, message }) => ({ name, message }))(describeError(outcome.error)),
      }),
    });
    return match.head
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  };

  const app: App = {
    async fetch(request) {
      if (state !== "running") {
        return problemResponse(503, "SHUTTING_DOWN", {
          detail: "The server is shutting down.",
          headers: { connection: "close" },
        });
      }
      inFlight++;
      try {
        return await handle(request);
      } catch (caught) {
        return problemResponse(
          500,
          "INTERNAL_ERROR",
          settings.development ? { debug: describeError(caught) } : {},
        );
      } finally {
        inFlight--;
        if (inFlight === 0) drained?.();
      }
    },
    close() {
      closing ??= (async () => {
        state = "closing";
        if (options.health !== undefined) markDraining(options.health);
        // Drain within the budget, then abort what is left and give it a moment to settle.
        const waitDrained = (ms: number) =>
          new Promise<void>((resolve) => {
            if (inFlight === 0) return resolve();
            const timer = setTimeout(resolve, ms);
            drained = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        await waitDrained(shutdownTimeoutMs);
        if (inFlight > 0) {
          shutdown.abort(new DOMException("The server is shutting down.", "AbortError"));
          await waitDrained(Math.min(1_000, shutdownTimeoutMs));
        }
        const errors = await stopResources(lifecycle, shutdownTimeoutMs, emit);
        state = "closed";
        if (errors.length > 0) {
          throw new AggregateError(errors, `${errors.length} lifecycle resource(s) failed to stop`);
        }
      })();
      return closing;
    },
  };
  return Object.freeze(app);
}
