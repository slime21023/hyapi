import * as Format from "typebox/format";
import { compileContracts } from "../contract/check.ts";
import type { AnyContract, Api, Contract } from "../contract/define.ts";
import { describeErrors, type Diagnostic, type DiagnosticCode } from "../contract/diagnostics.ts";
import type { FormatModel } from "../contract/model.ts";
import type { Schemes } from "../contract/security.ts";
import {
  type Binding,
  bindOperations,
  checkLifecycle,
  checkVerifiers,
  positiveInteger,
  type StartupDiagnosticCode,
  type StartupReport,
} from "./binding.ts";
import { type AppEvent, createEmitter, type Emit, type EventListener } from "./events.ts";
import type { Implementation } from "./handler.ts";
import {
  type LifecycleFailure,
  type LifecycleResource,
  startResources,
  stopResources,
} from "./lifecycle.ts";
import {
  execute,
  type OperationPlan,
  type Outcome,
  planOperation,
  type ResponseValidation,
} from "./pipeline.ts";
import { describeError, problemResponse } from "./problem.ts";
import { compileRoutes, type RouteMatch, type Router } from "./routing.ts";
import { createSecurity, type SecurityEvaluator, type Verifiers } from "./security.ts";
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
class TrackedBody implements UnderlyingDefaultSource<Uint8Array> {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #done: () => void;
  readonly #shutdown: AbortSignal;
  #finished = false;
  #abort: (() => void) | undefined;

  constructor(body: ReadableStream<Uint8Array>, done: () => void, shutdown: AbortSignal) {
    this.#reader = body.getReader();
    this.#done = done;
    this.#shutdown = shutdown;
  }

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#abort = () => {
      void this.#reader.cancel(this.#shutdown.reason).catch(() => {});
      controller.error(this.#shutdown.reason);
      this.#finish();
    };
    if (this.#shutdown.aborted) this.#abort();
    else this.#shutdown.addEventListener("abort", this.#abort, { once: true });
  }

  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      const { done, value } = await this.#reader.read();
      if (!done) return controller.enqueue(value);
      controller.close();
      this.#finish();
    } catch (error) {
      controller.error(error);
      this.#finish();
    }
  }

  cancel(reason?: unknown): Promise<void> {
    this.#finish();
    return this.#reader.cancel(reason);
  }

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#abort !== undefined) this.#shutdown.removeEventListener("abort", this.#abort);
    this.#done();
  }
}

/** Counts in-flight requests and lets `close()` wait until they finish. */
class InFlight {
  #count = 0;
  #drained: (() => void) | undefined;

  get count(): number {
    return this.#count;
  }

  enter(): void {
    this.#count++;
  }

  leave(): void {
    this.#count--;
    if (this.#count === 0) this.#drained?.();
  }

  /** Resolves when no request is in flight, or after `ms`. */
  drained(ms: number): Promise<void> {
    return new Promise((resolve) => this.#whenDrained(resolve, ms));
  }

  #whenDrained(resolve: () => void, ms: number): void {
    if (this.#count === 0) return resolve();
    const timer = setTimeout(resolve, ms);
    this.#drained = () => {
      clearTimeout(timer);
      resolve();
    };
  }
}

function notImplementedWarnings(bindings: readonly Binding[]): AppEvent[] {
  return bindings.filter((binding) => binding.handler === undefined).map(({ operation }) => ({
    type: "startup.warning",
    code: "not-implemented",
    message: "the operation is not implemented yet and answers 501",
    operationId: operation.operationId,
  }));
}

type Settings = ReturnType<typeof readSettings>;
type DocumentEndpoint = NonNullable<ReturnType<typeof documentEndpoint>>;

/** Everything a started application needs, prepared by {@link createApp}. */
interface Runtime {
  readonly settings: Settings;
  readonly emit: Emit;
  readonly router: Router;
  readonly plans: ReadonlyMap<string, OperationPlan>;
  readonly security: SecurityEvaluator;
  readonly lifecycle: readonly LifecycleResource[];
  readonly document: DocumentEndpoint | undefined;
}

/** A response, and whether its body streams and so keeps the request in flight. */
interface Handled {
  readonly response: Response;
  readonly streaming: boolean;
}

const buffered = (response: Response): Handled => ({ response, streaming: false });

const shuttingDown = () =>
  problemResponse(503, "SHUTTING_DOWN", {
    detail: "The server is shutting down.",
    headers: { connection: "close" },
  });

/** The opt-in document endpoint answers GET and HEAD. */
function serveDocument(document: DocumentEndpoint, method: string): Response {
  if (method !== "GET" && method !== "HEAD") {
    return problemResponse(405, "METHOD_NOT_ALLOWED", { headers: { allow: "GET, HEAD" } });
  }
  return new Response(method === "HEAD" ? null : document.text, {
    headers: { "content-type": document.type },
  });
}

/** The problem response for a request that matches no operation. */
function unmatched(
  match: Exclude<RouteMatch, { kind: "found" }>,
  method: string,
  pathname: string,
): Response {
  switch (match.kind) {
    case "malformed-path":
      return problemResponse(400, "MALFORMED_REQUEST", {
        detail: "The path is not valid percent-encoding.",
      });
    case "not-found":
      return problemResponse(404, "NOT_FOUND", { detail: `No operation matches ${pathname}.` });
  }
  return problemResponse(405, "METHOD_NOT_ALLOWED", {
    detail: `${method} is not declared for ${pathname}.`,
    headers: { allow: match.allow.join(", ") },
  });
}

/** A started application: the only owner of mutable state in Core (ADR 0003 §2). */
class RunningApp {
  readonly #runtime: Runtime;
  readonly #inFlight = new InFlight();
  readonly #shutdown = new AbortController();
  #state: "running" | "closing" | "closed" = "running";
  #closing: Promise<void> | undefined;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#state !== "running") return shuttingDown();
    this.#inFlight.enter();
    // A streamed body keeps the request in flight until it ends, so close() waits for it and
    // lifecycle resources stop only after it.
    let streaming = false;
    try {
      const handled = await this.#handle(request);
      streaming = handled.streaming;
      return streaming ? this.#track(handled.response) : handled.response;
    } catch (caught) {
      const { development } = this.#runtime.settings;
      return problemResponse(
        500,
        "INTERNAL_ERROR",
        development ? { debug: describeError(caught) } : {},
      );
    } finally {
      if (!streaming) this.#inFlight.leave();
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#stop();
    return this.#closing;
  }

  async #stop(): Promise<void> {
    const { settings, lifecycle, emit } = this.#runtime;
    this.#state = "closing";
    // Drain within the budget, then abort what is left and give it a moment to settle.
    await this.#inFlight.drained(settings.shutdownTimeoutMs);
    if (this.#inFlight.count > 0) {
      this.#shutdown.abort(new DOMException("The server is shutting down.", "AbortError"));
      await this.#inFlight.drained(Math.min(1_000, settings.shutdownTimeoutMs));
    }
    const failures = await stopResources(lifecycle, settings.shutdownTimeoutMs);
    for (const failure of failures) emit(lifecycleEvent(failure));
    this.#state = "closed";
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `${failures.length} lifecycle resource(s) failed to stop`,
      );
    }
  }

  #track(response: Response): Response {
    const source = new TrackedBody(
      response.body!,
      () => this.#inFlight.leave(),
      this.#shutdown.signal,
    );
    return new Response(new ReadableStream(source), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async #handle(request: Request): Promise<Handled> {
    const { router, document } = this.#runtime;
    const url = new URL(request.url);
    if (document !== undefined && url.pathname === document.path) {
      return buffered(serveDocument(document, request.method));
    }
    const match = router.match(request.method, url.pathname);
    if (match.kind !== "found") return buffered(unmatched(match, request.method, url.pathname));
    return await this.#runOperation(request, url, match);
  }

  async #runOperation(
    request: Request,
    url: URL,
    match: Extract<RouteMatch, { kind: "found" }>,
  ): Promise<Handled> {
    const { emit, plans, settings, security } = this.#runtime;
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
      this.#shutdown.signal,
    );
    this.#report(outcome, base, started);
    const { response } = outcome;
    if (!match.head) {
      return { response, streaming: outcome.streaming === true && response.body !== null };
    }
    void response.body?.cancel().catch(() => {});
    return buffered(new Response(null, { status: response.status, headers: response.headers }));
  }

  /** Turns the facts of an outcome into events (ADR 0003 §9). */
  #report(
    outcome: Outcome,
    base: { operationId: string; method: string; path: string; deprecated: boolean },
    started: number,
  ): void {
    const { emit } = this.#runtime;
    const { operationId } = base;
    if (outcome.stripped !== undefined) {
      emit({ type: "response.stripped", operationId, ...outcome.stripped });
    }
    if (outcome.violation !== undefined) {
      emit({ type: "response.violation", operationId, ...outcome.violation });
    }
    const error = outcome.error === undefined ? undefined : describeError(outcome.error);
    emit({
      type: "operation.end",
      ...base,
      status: outcome.response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(error === undefined ? {} : { error: { name: error.name, message: error.message } }),
    });
  }
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
  if (settings.development) notImplementedWarnings(bindings).forEach(emit);

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
  const running = new RunningApp({
    settings,
    emit,
    router,
    plans,
    security,
    lifecycle,
    document,
  });
  return Object.freeze({
    fetch: (request: Request) => running.fetch(request),
    close: () => running.close(),
  });
}
