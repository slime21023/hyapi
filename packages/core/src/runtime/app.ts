import * as Format from "typebox/format";
import type { Api } from "../contract/declare/api.ts";
import type { FormatModel } from "../contract/model.ts";
import { type ServedDocument, serveDocument } from "./documents.ts";
import { type AppEvent, createEmitter, type Emit } from "./events.ts";
import {
  type LifecycleFailure,
  type LifecycleResource,
  startResources,
  stopResources,
} from "./lifecycle.ts";
import { type AppOptions, requestIdOf, type Settings } from "./options.ts";
import {
  execute,
  type Incoming,
  type OperationPlan,
  planOperation,
  SHUTTING_DOWN,
} from "./pipeline.ts";
import { describeError, problemResponse } from "./problem.ts";
import { type Outcome, shuttingDown, unmatched, UNMATCHED_CODES } from "./respond.ts";
import type { RouteMatch, Router } from "./routing.ts";
import { createSecurity, type SecurityEvaluator } from "./security.ts";
import { type Binding, checkStartup } from "./startup.ts";
import { createValidators } from "./validation.ts";

/**
 * A Web-standard request handler: `app.fetch`, and what an outer wrapper such as a CORS plugin
 * takes and returns, `(fetch, options) => fetch`.
 */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** A running HyAPI application. */
export interface App {
  /** Handles one request. Compatible with `Deno.serve` and any Web-standard host. */
  readonly fetch: FetchHandler;
  /**
   * Stops admitting requests (new ones get 503), drains in-flight requests within the shutdown
   * budget, aborts the rest, then stops lifecycle resources in reverse order. Idempotent. Rejects
   * with an `AggregateError` when resources fail to stop.
   */
  close(): Promise<void>;
}

function registerFormats(formats: readonly FormatModel[]): void {
  for (const { name, check } of formats) if (!Format.Has(name)) Format.Set(name, check);
}

function lifecycleEvent(failure: LifecycleFailure): AppEvent {
  return {
    type: "lifecycle.error",
    name: failure.name,
    phase: failure.phase,
    error: describeError(failure.error),
  };
}

/** The `requestId` field of events: present only when request IDs are on. */
const scoped = (requestId: string | undefined) => requestId === undefined ? {} : { requestId };

/** A copy of a response with one more header; response headers can be immutable. */
function withHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Passes a streamed body through, calling `done` once when it ends, fails, or is cancelled. When
 * the request's `signal` aborts, as it does at forced shutdown, the body is cancelled and the
 * stream errors with the abort reason.
 */
class TrackedBody implements UnderlyingDefaultSource<Uint8Array> {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #done: () => void;
  readonly #signal: AbortSignal;
  #finished = false;
  #abort: (() => void) | undefined;

  constructor(body: ReadableStream<Uint8Array>, done: () => void, signal: AbortSignal) {
    this.#reader = body.getReader();
    this.#done = done;
    this.#signal = signal;
  }

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#abort = () => {
      void this.#reader.cancel(this.#signal.reason).catch(() => {});
      controller.error(this.#signal.reason);
      this.#finish();
    };
    if (this.#signal.aborted) this.#abort();
    else this.#signal.addEventListener("abort", this.#abort, { once: true });
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
    if (this.#abort !== undefined) this.#signal.removeEventListener("abort", this.#abort);
    this.#done();
  }
}

/**
 * The controllers of in-flight requests. `close()` waits until there are none, and aborts the
 * rest when the shutdown budget runs out.
 */
class InFlight {
  readonly #requests = new Set<AbortController>();
  #drained: (() => void) | undefined;

  get count(): number {
    return this.#requests.size;
  }

  enter(request: AbortController): void {
    this.#requests.add(request);
  }

  leave(request: AbortController): void {
    this.#requests.delete(request);
    if (this.#requests.size === 0) this.#drained?.();
  }

  /** Aborts every in-flight request with `reason`. */
  abortAll(reason: unknown): void {
    for (const request of this.#requests) request.abort(reason);
  }

  /** Resolves when no request is in flight, or after `ms`. */
  drained(ms: number): Promise<void> {
    return new Promise((resolve) => this.#whenDrained(resolve, ms));
  }

  #whenDrained(resolve: () => void, ms: number): void {
    if (this.#requests.size === 0) return resolve();
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

/** Everything a started application needs, prepared by {@link createApp}. */
interface Runtime {
  readonly settings: Settings;
  readonly emit: Emit;
  readonly router: Router;
  readonly plans: ReadonlyMap<string, OperationPlan>;
  readonly security: SecurityEvaluator;
  readonly lifecycle: readonly LifecycleResource[];
  readonly documents: ReadonlyMap<string, ServedDocument>;
}

/** The fields shared by the events of one operation. */
interface Base {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly deprecated: boolean;
  readonly requestId?: string;
}

/** A response, and whether its body streams and so keeps the request in flight. */
interface Handled {
  readonly response: Response;
  readonly streaming: boolean;
}

const buffered = (response: Response): Handled => ({ response, streaming: false });

/** A started application: the only owner of mutable state in Core (ADR 0003 §2). */
class RunningApp {
  readonly #runtime: Runtime;
  readonly #inFlight = new InFlight();
  #state: "running" | "closing" | "closed" = "running";
  #closing: Promise<void> | undefined;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  async fetch(request: Request): Promise<Response> {
    const ids = this.#runtime.settings.requestId;
    if (ids === undefined) return await this.#respond(request, undefined);
    const requestId = requestIdOf(request, ids);
    return withHeader(await this.#respond(request, requestId), ids.header, requestId);
  }

  async #respond(request: Request, requestId: string | undefined): Promise<Response> {
    if (this.#state !== "running") return shuttingDown();
    const controller = new AbortController();
    this.#inFlight.enter(controller);
    // A streamed body keeps the request in flight until it ends, so close() waits for it and
    // lifecycle resources stop only after it.
    let streaming = false;
    try {
      const handled = await this.#handle(request, requestId, controller);
      streaming = handled.streaming;
      return streaming ? this.#track(handled.response, controller) : handled.response;
    } catch (caught) {
      const { development } = this.#runtime.settings;
      return problemResponse(
        500,
        "INTERNAL_ERROR",
        development ? { debug: describeError(caught) } : {},
      );
    } finally {
      if (!streaming) this.#inFlight.leave(controller);
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
      this.#inFlight.abortAll(SHUTTING_DOWN);
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

  #track(response: Response, controller: AbortController): Response {
    const source = new TrackedBody(
      response.body!,
      () => this.#inFlight.leave(controller),
      controller.signal,
    );
    return new Response(new ReadableStream(source), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async #handle(
    request: Request,
    requestId: string | undefined,
    controller: AbortController,
  ): Promise<Handled> {
    const { router, documents, emit } = this.#runtime;
    const url = new URL(request.url);
    const document = documents.get(url.pathname);
    if (document !== undefined) return buffered(serveDocument(document, request.method));
    const match = router.match(request.method, url.pathname);
    if (match.kind === "found") {
      const incoming = { request, url, params: match.params, requestId };
      return await this.#runOperation(incoming, match, controller);
    }
    const response = unmatched(match, request.method, url.pathname);
    emit({
      type: "request.unmatched",
      method: request.method,
      path: url.pathname,
      status: response.status,
      code: UNMATCHED_CODES[match.kind],
      ...scoped(requestId),
    });
    return buffered(response);
  }

  async #runOperation(
    incoming: Incoming,
    match: Extract<RouteMatch, { kind: "found" }>,
    controller: AbortController,
  ): Promise<Handled> {
    const { emit, plans, settings, security } = this.#runtime;
    const { operation } = match;
    const base: Base = {
      operationId: operation.operationId,
      method: incoming.request.method,
      path: operation.path,
      deprecated: operation.deprecated,
      ...scoped(incoming.requestId),
    };
    emit({ type: "operation.start", ...base });
    const started = performance.now();
    const outcome = await execute(
      plans.get(operation.operationId)!,
      incoming,
      settings,
      security,
      controller,
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
  #report(outcome: Outcome, base: Base, started: number): void {
    const { emit } = this.#runtime;
    const { operationId, method, path, requestId } = base;
    const id = scoped(requestId);
    if (outcome.denial !== undefined) {
      const { status, reason, schemes, requiredScopes } = outcome.denial;
      emit({
        type: "security.denied",
        operationId,
        method,
        path,
        status,
        reason,
        schemes,
        ...(requiredScopes === undefined ? {} : { requiredScopes }),
        ...id,
      });
    }
    if (outcome.stripped !== undefined) {
      emit({ type: "response.stripped", operationId, ...outcome.stripped, ...id });
    }
    if (outcome.violation !== undefined) {
      emit({ type: "response.violation", operationId, ...outcome.violation, ...id });
    }
    emit({
      type: "operation.end",
      ...base,
      status: outcome.response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
      ...(outcome.error === undefined ? {} : { error: describeError(outcome.error) }),
    });
  }
}

/**
 * Assembles an API and its implementations into an application, starts its lifecycle resources,
 * and returns it. Every contract, implementation, and option problem is reported together in a
 * {@link StartupError}.
 */
export async function createApp<Definition extends Api>(
  options: AppOptions<Definition>,
): Promise<App> {
  const emit = createEmitter(options.onEvent);
  const { settings, model, bindings, verifiers, lifecycle, router, documents, warnings } =
    checkStartup(options);
  for (const d of warnings) {
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
    bindings.map(({ operation, handler, timeoutMs, bodyLimitBytes }) => [
      operation.operationId,
      planOperation(operation, handler, { timeoutMs, bodyLimitBytes }, validators),
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
    documents,
  });
  return Object.freeze({
    fetch: (request: Request) => running.fetch(request),
    close: () => running.close(),
  });
}
