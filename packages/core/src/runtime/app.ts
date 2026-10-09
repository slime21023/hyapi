import * as Format from "typebox/format";
import { compileContracts } from "../contract/check.ts";
import type { AnyContract, Api, Contract } from "../contract/define.ts";
import { describeErrors, type Diagnostic, type DiagnosticCode } from "../contract/diagnostics.ts";
import type { FormatModel } from "../contract/model.ts";
import type { Schemes } from "../contract/security.ts";
import {
  bindOperations,
  checkLifecycle,
  checkVerifiers,
  positiveInteger,
  type StartupDiagnosticCode,
  type StartupReport,
} from "./binding.ts";
import { type AppEvent, createEmitter, type EventListener } from "./events.ts";
import type { Implementation } from "./handler.ts";
import {
  type LifecycleFailure,
  type LifecycleResource,
  startResources,
  stopResources,
} from "./lifecycle.ts";
import { execute, type Outcome, planOperation, type ResponseValidation } from "./pipeline.ts";
import { describeError, problemResponse } from "./problem.ts";
import { compileRoutes, type Router } from "./routing.ts";
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

export type { StartupDiagnosticCode };

/** Thrown by {@link createApp} with every diagnostic that prevents startup. */
export class StartupError extends Error {
  readonly diagnostics: readonly Diagnostic<DiagnosticCode | StartupDiagnosticCode>[];

  constructor(diagnostics: readonly Diagnostic<DiagnosticCode | StartupDiagnosticCode>[]) {
    const count = diagnostics.filter((d) => d.severity === "error").length;
    super(
      `The application cannot start (${count} error${count === 1 ? "" : "s"}):\n` +
        describeErrors(diagnostics),
    );
    this.name = "StartupError";
    this.diagnostics = diagnostics;
  }
}

function readSettings(options: BaseOptions<Api>, error: StartupReport) {
  const development = options.development ?? false;
  const settings = {
    development,
    responseValidation: options.responseValidation ?? (development ? "enforce" : "log"),
    bodyLimitBytes: options.bodyLimitBytes ?? 1_048_576,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
  } as const;
  if (!["off", "log", "enforce"].includes(settings.responseValidation)) {
    error("invalid-option", "responseValidation must be 'off', 'log', or 'enforce'");
  }
  for (const name of ["requestTimeoutMs", "bodyLimitBytes", "shutdownTimeoutMs"] as const) {
    if (!positiveInteger(settings[name])) {
      error("invalid-option", `${name} must be a positive integer`);
    }
  }
  return settings;
}

/**
 * TypeBox's format registry is process-wide and cannot remove entries (ADR 0003 §5), so a name
 * registered with a different check by anything else is a conflict.
 */
function checkFormats(formats: readonly FormatModel[], error: StartupReport): void {
  for (const { name, check } of formats) {
    const registered = Format.Get(name);
    if (registered !== undefined && registered !== check) {
      error(
        "format-conflict",
        `format '${name}' is already registered in this process with a different check`,
      );
    }
  }
}

function registerFormats(formats: readonly FormatModel[]): void {
  for (const { name, check } of formats) if (!Format.Has(name)) Format.Set(name, check);
}

/** The opt-in document endpoint; it must not shadow a declared route. */
function documentEndpoint(
  document: BaseOptions<Api>["document"],
  router: Router,
  error: StartupReport,
): { readonly path: string; readonly text: string; readonly type: string } | undefined {
  if (document === undefined) return undefined;
  if (typeof document.path !== "string" || !document.path.startsWith("/")) {
    error("invalid-option", "document.path must start with '/'");
    return undefined;
  }
  if (router.match("GET", document.path).kind !== "not-found") {
    error("document-route-conflict", `document.path '${document.path}' is a declared route`);
    return undefined;
  }
  const yaml = /\.ya?ml$/i.test(document.path);
  return typeof document.content === "string"
    ? {
      path: document.path,
      text: document.content,
      type: yaml ? "application/yaml" : "application/json",
    }
    : { path: document.path, text: JSON.stringify(document.content), type: "application/json" };
}

function lifecycleEvent(failure: LifecycleFailure): AppEvent {
  const { name, message } = describeError(failure.error);
  return {
    type: "lifecycle.error",
    name: failure.name,
    phase: failure.phase,
    error: { name, message },
  };
}

/**
 * Passes a streamed body through, calling `done` once when it ends, fails, or is cancelled. When
 * `shutdown` aborts, the body is cancelled and the stream errors with the abort reason.
 */
function trackBody(
  body: ReadableStream<Uint8Array>,
  done: () => void,
  shutdown: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  let abort: (() => void) | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (abort !== undefined) shutdown.removeEventListener("abort", abort);
    done();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        void reader.cancel(shutdown.reason).catch(() => {});
        controller.error(shutdown.reason);
        finish();
      };
      if (shutdown.aborted) abort();
      else shutdown.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          controller.close();
          finish();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

/** Counts in-flight requests and lets `close()` wait until they finish. */
function createTracker() {
  let inFlight = 0;
  let drained: (() => void) | undefined;
  return {
    enter() {
      inFlight++;
    },
    leave() {
      inFlight--;
      if (inFlight === 0) drained?.();
    },
    get count() {
      return inFlight;
    },
    /** Resolves when no request is in flight, or after `ms`. */
    wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        if (inFlight === 0) return resolve();
        const timer = setTimeout(resolve, ms);
        drained = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}

/**
 * Assembles an API and its implementations into an application, starts its lifecycle resources,
 * and returns it. Every contract, implementation, and option problem is reported together in a
 * {@link StartupError}.
 */
export async function createApp<A extends Api>(options: AppOptions<A>): Promise<App> {
  const emit = createEmitter(options.onEvent);
  const diagnostics: Diagnostic<DiagnosticCode | StartupDiagnosticCode>[] = [];
  const error: StartupReport = (code, message, operationId) =>
    diagnostics.push({ severity: "error", code, message, ...(operationId ? { operationId } : {}) });

  const settings = readSettings(options, error);
  const lifecycle = options.lifecycle ?? [];
  checkLifecycle(lifecycle, error);

  const compiled = compileContracts(options.api);
  diagnostics.push(...compiled.diagnostics);
  if (!compiled.ok) throw new StartupError(diagnostics);
  const { model } = compiled;

  const bindings = bindOperations(
    model,
    options.api.contracts as readonly AnyContract[],
    options.implementations,
    (options.timeouts ?? {}) as Readonly<Record<string, unknown>>,
    settings.requestTimeoutMs,
    error,
  );
  const verifiers = (options.verifiers ?? {}) as Readonly<Record<string, unknown>>;
  checkVerifiers(model, verifiers, error);
  checkFormats(model.formats, error);
  const router = compileRoutes(model.operations);
  const document = documentEndpoint(options.document, router, error);

  if (diagnostics.some((d) => d.severity === "error")) throw new StartupError(diagnostics);
  for (const d of diagnostics) {
    emit({
      type: "startup.warning",
      code: d.code,
      message: d.message,
      ...(d.operationId === undefined ? {} : { operationId: d.operationId }),
    });
  }
  if (settings.development) {
    for (const { operation, handler } of bindings) {
      if (handler !== undefined) continue;
      emit({
        type: "startup.warning",
        code: "not-implemented",
        message: "the operation is not implemented yet and answers 501",
        operationId: operation.operationId,
      });
    }
  }

  // Every check passed: only now touch process-wide state and compile validators.
  registerFormats(model.formats);
  const validators = createValidators();
  const plans = new Map(
    bindings.map(({ operation, handler, timeoutMs }) => [
      operation.operationId,
      planOperation(operation, handler, timeoutMs, validators),
    ]),
  );

  const failures = await startResources(lifecycle, settings.shutdownTimeoutMs);
  if (failures.length > 0) {
    for (const failure of failures) emit(lifecycleEvent(failure));
    const [{ name, error: cause }, ...rollback] = failures as [
      LifecycleFailure,
      ...LifecycleFailure[],
    ];
    if (rollback.length === 0) throw cause;
    throw new AggregateError(
      [cause, ...rollback.map((failure) => failure.error)],
      `'${name}' failed to start`,
      { cause },
    );
  }

  const security = createSecurity(
    model.securitySchemes,
    verifiers as Parameters<typeof createSecurity>[1],
    model.info.title,
  );
  const shutdown = new AbortController();
  const tracker = createTracker();
  let state: "running" | "closing" | "closed" = "running";
  let closing: Promise<void> | undefined;

  const report = (outcome: Outcome, operationId: string) => {
    if (outcome.stripped !== undefined) {
      emit({ type: "response.stripped", operationId, ...outcome.stripped });
    }
    if (outcome.violation !== undefined) {
      emit({ type: "response.violation", operationId, ...outcome.violation });
    }
  };

  const handle = async (request: Request): Promise<{ response: Response; streaming: boolean }> => {
    const url = new URL(request.url);
    const buffered = (response: Response) => ({ response, streaming: false });
    if (document !== undefined && url.pathname === document.path) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return buffered(
          problemResponse(405, "METHOD_NOT_ALLOWED", { headers: { allow: "GET, HEAD" } }),
        );
      }
      return buffered(
        new Response(request.method === "HEAD" ? null : document.text, {
          headers: { "content-type": document.type },
        }),
      );
    }
    const match = router.match(request.method, url.pathname);
    switch (match.kind) {
      case "not-found":
        return buffered(problemResponse(404, "NOT_FOUND", {
          detail: `No operation matches ${url.pathname}.`,
        }));
      case "method-not-allowed":
        return buffered(problemResponse(405, "METHOD_NOT_ALLOWED", {
          detail: `${request.method} is not declared for ${url.pathname}.`,
          headers: { allow: match.allow.join(", ") },
        }));
      case "malformed-path":
        return buffered(problemResponse(400, "MALFORMED_REQUEST", {
          detail: "The path is not valid percent-encoding.",
        }));
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
    report(outcome, operation.operationId);
    const { response } = outcome;
    emit({
      type: "operation.end",
      ...base,
      status: response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(outcome.error === undefined ? {} : {
        error: (({ name, message }) => ({ name, message }))(describeError(outcome.error)),
      }),
    });
    if (match.head) {
      void response.body?.cancel().catch(() => {});
      return buffered(new Response(null, { status: response.status, headers: response.headers }));
    }
    return { response, streaming: outcome.streaming === true && response.body !== null };
  };

  const app: App = {
    async fetch(request) {
      if (state !== "running") {
        return problemResponse(503, "SHUTTING_DOWN", {
          detail: "The server is shutting down.",
          headers: { connection: "close" },
        });
      }
      tracker.enter();
      // A streamed body keeps the request in flight until it ends, so close() waits for it and
      // lifecycle resources stop only after it.
      let streaming = false;
      try {
        const { response, streaming: streams } = await handle(request);
        if (!streams) return response;
        streaming = true;
        return new Response(trackBody(response.body!, tracker.leave, shutdown.signal), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (caught) {
        return problemResponse(
          500,
          "INTERNAL_ERROR",
          settings.development ? { debug: describeError(caught) } : {},
        );
      } finally {
        if (!streaming) tracker.leave();
      }
    },
    close() {
      closing ??= (async () => {
        state = "closing";
        // Drain within the budget, then abort what is left and give it a moment to settle.
        await tracker.wait(settings.shutdownTimeoutMs);
        if (tracker.count > 0) {
          shutdown.abort(new DOMException("The server is shutting down.", "AbortError"));
          await tracker.wait(Math.min(1_000, settings.shutdownTimeoutMs));
        }
        const stopFailures = await stopResources(lifecycle, settings.shutdownTimeoutMs);
        for (const failure of stopFailures) emit(lifecycleEvent(failure));
        state = "closed";
        if (stopFailures.length > 0) {
          throw new AggregateError(
            stopFailures.map((failure) => failure.error),
            `${stopFailures.length} lifecycle resource(s) failed to stop`,
          );
        }
      })();
      return closing;
    },
  };
  return Object.freeze(app);
}
