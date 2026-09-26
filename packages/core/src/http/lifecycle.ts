import type { LifecycleContext } from "../types.ts";
import { AppError } from "../errors.ts";
import type { RequestServices } from "../runtime/services.ts";
import { Scope } from "../runtime/scope.ts";
import { sleep } from "../runtime/timers.ts";
import { DEADLINE_HEADER, parseDeadlineHeader } from "./deadline.ts";

/** Hono bindings owned by the HTTP request lifecycle. */
export type HttpPipelineEnv = { Bindings: { scope: HttpRequestScope } };

/**
 * Everything one HTTP request owns: its deadline, abort signal, lifecycle context, and
 * request-scoped services. A single timer aborts the request when its effective deadline passes.
 */
export class HttpRequestScope {
  readonly request: Request;
  readonly requestId: string;
  readonly deadline: number;
  readonly deadlineSource: "header" | "timeout";
  readonly controller = new AbortController();
  readonly #disconnect = new AbortController();
  readonly #onDisconnect: () => void;
  #lifecycleRequest: Request;
  /** Aborted by the deadline, by a forced shutdown, or when the client disconnects. */
  readonly signal: AbortSignal;
  readonly lifecycle: LifecycleContext;
  readonly services: RequestServices;
  readonly #requestTimeoutMs: number;
  readonly #expired: Promise<never>;
  readonly #cancelTimer: () => void;
  #ended = false;
  failureSelected = false;

  constructor(request: Request, requestId: string, requestTimeoutMs: number) {
    this.request = request;
    this.requestId = requestId;
    this.services = {
      scope: new Scope("Request cleanup failed."),
      cache: new Map(),
    };
    this.#requestTimeoutMs = requestTimeoutMs;
    const timeoutDeadline = Date.now() + requestTimeoutMs;
    const headerDeadline = parseDeadlineHeader(request.headers.get(DEADLINE_HEADER));
    const fromHeader = headerDeadline !== undefined && headerDeadline <= timeoutDeadline;
    this.deadline = fromHeader ? headerDeadline : timeoutDeadline;
    this.deadlineSource = fromHeader ? "header" : "timeout";
    this.signal = AbortSignal.any([this.controller.signal, this.#disconnect.signal]);
    this.#lifecycleRequest = request;
    this.#onDisconnect = () => this.#disconnect.abort(request.signal.reason);
    if (request.signal.aborted) this.#onDisconnect();
    else request.signal.addEventListener("abort", this.#onDisconnect, { once: true });
    const lifecycleRequest = () => this.#lifecycleRequest;
    this.lifecycle = {
      get request() {
        return lifecycleRequest();
      },
      requestId,
      state: new Map(),
      route: null,
      identity: null,
      response: null,
      error: null,
    };
    const { promise: expired, reject } = Promise.withResolvers<never>();
    expired.catch(() => undefined);
    this.#expired = expired;
    this.controller.signal.addEventListener(
      "abort",
      () => reject(this.controller.signal.reason),
      { once: true },
    );
    const timer = setTimeout(
      () => this.controller.abort(this.deadlineError()),
      Math.max(0, this.deadline - Date.now()),
    );
    this.#cancelTimer = () => clearTimeout(timer);
  }

  setLifecycleRequest(request: Request): void {
    this.#lifecycleRequest = request;
  }

  deadlineError(): AppError {
    return this.deadlineSource === "timeout"
      ? new AppError(
        503,
        "REQUEST_TIMEOUT",
        `The request did not complete within ${this.#requestTimeoutMs} ms.`,
        undefined,
        true,
      )
      : new AppError(504, "DEADLINE_EXCEEDED", "The request deadline has passed.", undefined, true);
  }

  /**
   * Races `operation` against the deadline. JavaScript cannot stop running code, so abandoned
   * work is retained for shutdown and can observe `signal` to stop early.
   */
  async race<T>(operation: () => Promise<T>, tasks: HttpTaskTracker): Promise<T> {
    const execution = operation();
    try {
      return await Promise.race([execution, this.#expired]);
    } catch (error) {
      if (this.controller.signal.aborted) tasks.track(execution);
      throw error;
    }
  }

  /**
   * Observe a notification only while the request is live. Cleanup notifications run after end()
   * stops the request timer, so they need their own cancellable wait for the same deadline.
   */
  async observe(task: Promise<void>, tasks: HttpTaskTracker): Promise<void> {
    let deadlineWait: Promise<unknown> = this.#expired;
    let timer: AbortController | undefined;
    if (this.#ended) {
      const remaining = this.deadline - Date.now();
      if (remaining <= 0 || this.controller.signal.aborted) {
        tasks.track(task);
        return;
      }
      timer = new AbortController();
      deadlineWait = Promise.race([this.#expired, sleep(remaining, timer.signal)]);
    }
    try {
      const completed = await Promise.race([
        task.then(() => true, () => true),
        deadlineWait.then(() => false, () => false),
      ]);
      if (!completed) tasks.track(task);
    } finally {
      timer?.abort();
    }
  }

  end(): void {
    this.#ended = true;
    this.#cancelTimer();
    this.request.signal.removeEventListener("abort", this.#onDisconnect);
  }
}

/** Tracks in-flight HTTP requests and abandoned HTTP work so shutdown can wait for them. */
export class HttpTaskTracker {
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #scopes = new Set<HttpRequestScope>();

  track(task: Promise<unknown>): void {
    this.#tasks.add(task);
    task.catch(() => undefined).finally(() => this.#tasks.delete(task));
  }

  register(scope: HttpRequestScope): void {
    this.#scopes.add(scope);
  }

  unregister(scope: HttpRequestScope): void {
    this.#scopes.delete(scope);
  }

  /** Resolves `true` once every tracked task settled, or `false` when `timeoutMs` elapses first. */
  async idle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#tasks.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const timer = new AbortController();
      await Promise.race([
        Promise.allSettled([...this.#tasks]),
        sleep(remaining, timer.signal).catch(() => undefined),
      ]);
      timer.abort();
    }
    return true;
  }

  abortAll(reason: unknown): void {
    for (const scope of this.#scopes) scope.controller.abort(reason);
  }
}
