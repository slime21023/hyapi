import type { Context, Hono } from "@hono/hono";
import {
  type AnyRouteDefinition,
  type AppConfig,
  type AuthProvider,
  extractResponseSchemas,
  type Identity,
  isProtectedAuth,
  type LifecycleContext,
  type LifecycleHook,
  type RequestContext,
  type ResponseResult,
} from "./types.ts";
import {
  AppError,
  ConfigurationError,
  ForbiddenError,
  ResponseContractError,
  toProblemDetails,
  UnauthorizedError,
  ValidationError,
} from "./errors.ts";
import { DEADLINE_HEADER, parseDeadlineHeader } from "./deadline.ts";
import type { HookPoint, RouteHooks } from "./routing.ts";
import type { RequestServices, ServiceContainer } from "./services.ts";
import { Scope } from "./scope.ts";
import { sleep } from "./timers.ts";
import {
  assertSupportedRequestMediaType,
  headerObject,
  limitRequestBody,
  parseRequestBody,
  queryObject,
  type SchemaValidator,
} from "./validation.ts";

export type PipelineEnv = { Bindings: { scope: RequestScope } };

const RESPONSE_RESULT = "__hyapiResponse" as const;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isResponseResult(value: unknown): value is ResponseResult {
  return typeof value === "object" && value !== null && RESPONSE_RESULT in value &&
    value[RESPONSE_RESULT] === true;
}

export function resolveRequestId(request: Request, header: string): string {
  const incoming = request.headers.get(header);
  return incoming !== null && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

export function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
}

export function errorResponse(error: unknown, request: Request, requestId: string): Response {
  const problem = toProblemDetails(error, request, requestId);
  const headers = new Headers({ "content-type": "application/problem+json" });
  if (problem.status === 401) headers.set("www-authenticate", "Bearer");
  return new Response(JSON.stringify(problem), { status: problem.status, headers });
}

/** Discard only bodies no longer returned to the caller; cancellation is best effort. */
function discardResponseBody(response: Response): void {
  if (!response.body || response.body.locked) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // A broken stream must not replace or delay the selected error response.
  }
}

async function runHookList(
  hooks: readonly LifecycleHook[],
  lifecycle: LifecycleContext,
  swallowErrors = false,
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(lifecycle);
    } catch (error) {
      if (!swallowErrors) throw error;
    }
  }
}

/**
 * Everything one request owns: its deadline, abort signal, lifecycle context, and request-scoped
 * services. A single timer aborts the request when the effective deadline passes.
 */
export class RequestScope {
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

  constructor(
    request: Request,
    requestId: string,
    requestTimeoutMs: number,
    services: RequestServices,
  ) {
    this.request = request;
    this.requestId = requestId;
    this.services = services;
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
   * Races `operation` against the deadline. JavaScript cannot stop running code, so an abandoned
   * operation keeps running as a tracked task and observes `signal` to stop early.
   */
  async race<T>(operation: () => Promise<T>, tasks: TaskTracker): Promise<T> {
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
  async observe(task: Promise<void>, tasks: TaskTracker): Promise<void> {
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

/** Tracks in-flight requests and abandoned work so shutdown can wait for them. */
export class TaskTracker {
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #scopes = new Set<RequestScope>();

  track(task: Promise<unknown>): void {
    this.#tasks.add(task);
    task.catch(() => undefined).finally(() => this.#tasks.delete(task));
  }

  register(scope: RequestScope): void {
    this.#scopes.add(scope);
  }

  unregister(scope: RequestScope): void {
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

/** What the pipeline needs from the application that owns it. */
export interface PipelineHost {
  readonly config: AppConfig;
  readonly validator: SchemaValidator;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly services: ServiceContainer;
  readonly tasks: TaskTracker;
  globalHooks(point: HookPoint): readonly LifecycleHook[];
  routeHooks(route: AnyRouteDefinition): RouteHooks;
  authProvider(): AuthProvider | null;
}

/**
 * The single request path: global onRequest → route (group onRequest, auth, validation, handler,
 * response contract) → group onResponse → global onResponse. Every failure becomes a problem
 * response through `failure()`.
 */
export class RequestPipeline {
  readonly #host: PipelineHost;

  constructor(host: PipelineHost) {
    this.#host = host;
  }

  async dispatch(request: Request, http: Hono<PipelineEnv>): Promise<Response> {
    const host = this.#host;
    const requestId = resolveRequestId(request, host.config.requestIdHeader);
    const scope = new RequestScope(request, requestId, host.requestTimeoutMs, {
      scope: new Scope("Request cleanup failed."),
      cache: new Map(),
    });
    host.tasks.register(scope);
    try {
      let response: Response;
      try {
        await scope.race(
          () => runHookList(host.globalHooks("onRequest"), scope.lifecycle),
          host.tasks,
        );
        response = await http.fetch(request, { scope });
      } catch (error) {
        response = await this.failure(scope, error);
      }
      response = await this.#runOnResponse(host.globalHooks("onResponse"), scope, response);
      if (scope.controller.signal.aborted && !scope.failureSelected) {
        discardResponseBody(response);
        response = await this.failure(scope, scope.controller.signal.reason);
      }
      try {
        return withHeader(response, host.config.requestIdHeader, requestId);
      } catch (error) {
        discardResponseBody(response);
        const fallback = await this.failure(scope, error);
        return withHeader(fallback, host.config.requestIdHeader, requestId);
      }
    } finally {
      scope.end();
      const cleanup = scope.services.scope.close(
        scope.controller.signal.aborted ? Math.min(scope.deadline, Date.now()) : scope.deadline,
      );
      try {
        if (scope.controller.signal.aborted) await cleanup;
        else await scope.race(() => cleanup, host.tasks);
      } catch (cleanupError) {
        if (scope.controller.signal.aborted && cleanupError === scope.controller.signal.reason) {
          // Shutdown can release the chosen response before cleanup finishes. Keep the abandoned
          // close tracked and report an eventual closer failure without changing that response.
          void cleanup.catch((error) => this.#notifyError(scope, error));
        } else {
          await this.#notifyError(scope, cleanupError);
        }
      }
      host.tasks.unregister(scope);
    }
  }

  async runRoute(context: Context<PipelineEnv>, route: AnyRouteDefinition): Promise<Response> {
    const scope = context.env.scope;
    scope.lifecycle.route = route;
    const hooks = this.#host.routeHooks(route);
    let response: Response;
    try {
      if (Date.now() >= scope.deadline) throw scope.deadlineError();
      response = await scope.race(
        () => this.#executeRoute(context, route, scope, hooks),
        this.#host.tasks,
      );
    } catch (error) {
      response = await this.failure(scope, error);
    }
    return await this.#runOnResponse(hooks.onResponse, scope, response);
  }

  /** The only place error responses are created; runs onError hooks first. */
  async failure(scope: RequestScope, error: unknown): Promise<Response> {
    scope.failureSelected = true;
    await this.#notifyError(scope, error);
    return errorResponse(error, scope.request, scope.requestId);
  }

  /** Runs route-scoped and global onError hooks; hook failures are swallowed. */
  async #notifyError(scope: RequestScope, error: unknown): Promise<void> {
    const lifecycle = scope.lifecycle;
    const observeHooks = async (hooks: readonly LifecycleHook[]) => {
      for (const hook of hooks) {
        // Hooks share state, but each must observe the failure being reported even if a prior
        // hook replaced lifecycle.error (or an abandoned hook later mutates it).
        lifecycle.error = error;
        try {
          await scope.observe(Promise.resolve(hook(lifecycle)), this.#host.tasks);
        } catch {
          // Error observers cannot replace or re-notify the selected failure.
        }
      }
    };
    const route = lifecycle.route;
    if (route) await observeHooks(this.#host.routeHooks(route).onError);
    await observeHooks(this.#host.globalHooks("onError"));
    lifecycle.error = error;
  }

  /** A failing hook replaces the response with a problem response; outer hooks still run. */
  async #runOnResponse(
    hooks: readonly LifecycleHook[],
    scope: RequestScope,
    response: Response,
  ): Promise<Response> {
    let current = response;
    if (scope.controller.signal.aborted && !scope.failureSelected) {
      discardResponseBody(current);
      current = await this.failure(scope, scope.controller.signal.reason);
    }
    for (const hook of hooks) {
      scope.lifecycle.response = current;
      if (scope.controller.signal.aborted) {
        // A failure is already selected. Let outer hooks inspect it, but do not let an abandoned
        // hook replace it or trigger another error notification after the deadline.
        try {
          await scope.observe(Promise.resolve(hook(scope.lifecycle)), this.#host.tasks);
        } catch {
          // The abort reason has precedence over a late observer failure.
        }
        continue;
      }
      try {
        await scope.race(() => Promise.resolve(hook(scope.lifecycle)), this.#host.tasks);
      } catch (error) {
        discardResponseBody(current);
        current = await this.failure(
          scope,
          scope.controller.signal.aborted ? scope.controller.signal.reason : error,
        );
      }
    }
    scope.lifecycle.response = current;
    return current;
  }

  async #executeRoute(
    context: Context<PipelineEnv>,
    route: AnyRouteDefinition,
    scope: RequestScope,
    hooks: RouteHooks,
  ): Promise<Response> {
    const host = this.#host;
    const request = context.req.raw;
    await runHookList(hooks.onRequest, scope.lifecycle);

    const identity = await this.#authenticate(request, route);
    scope.lifecycle.identity = identity;

    const requestSchemas = route.request;
    const params = requestSchemas?.params
      ? host.validator.validate(requestSchemas.params, context.req.param(), "params")
      : context.req.param();
    const query = requestSchemas?.query
      ? host.validator.validate(requestSchemas.query, queryObject(request), "query")
      : queryObject(request);
    const boundedRequest = limitRequestBody(request, host.bodyLimitBytes, scope.signal);
    let handlerRequest = boundedRequest;
    let rawBody: unknown;
    if (requestSchemas?.body && boundedRequest.body !== null) {
      try {
        assertSupportedRequestMediaType(boundedRequest);
      } catch (error) {
        // The limiter has acquired the original reader; rejection must release it without
        // waiting for an uncooperative stream to acknowledge cancellation.
        try {
          void boundedRequest.body.cancel().catch(() => undefined);
        } catch {
          // A broken source must not replace the unsupported-media response.
        }
        throw error;
      }
      const bytes = new Uint8Array(await boundedRequest.arrayBuffer());
      handlerRequest = new Request(boundedRequest, { body: bytes });
      scope.setLifecycleRequest(new Request(boundedRequest, { body: bytes }));
      rawBody = await parseRequestBody(boundedRequest, bytes);
    }
    if (requestSchemas?.body && rawBody === undefined && requestSchemas.bodyRequired !== false) {
      throw new ValidationError("body", [{
        keyword: "required",
        instancePath: "",
        schemaPath: "#",
        params: {},
        message: "request body is required",
      }]);
    }
    const body = requestSchemas?.body && rawBody !== undefined
      ? host.validator.validate(requestSchemas.body, rawBody, "body")
      : rawBody;
    const headers = requestSchemas?.headers
      ? host.validator.validate(
        requestSchemas.headers,
        headerObject(request.headers, requestSchemas.headers),
        "headers",
      )
      : headerObject(request.headers);

    const routeContext: RequestContext = {
      request: handlerRequest,
      requestId: scope.requestId,
      requestIdHeader: host.config.requestIdHeader,
      deadline: scope.deadline,
      signal: scope.signal,
      params,
      query,
      body,
      headers: new Headers(headers as Record<string, string>),
      identity,
      state: scope.lifecycle.state,
      services: host.services.resolver(scope.services),
      ok: <T>(value: T, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        init: { ...init, status: init?.status ?? 200 },
      }),
      created: <T>(value: T, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        init: { ...init, status: init?.status ?? 201 },
      }),
      noContent: (init?: ResponseInit): ResponseResult<undefined> => ({
        [RESPONSE_RESULT]: true,
        body: undefined,
        init: { ...init, status: 204 },
      }),
      json: <T>(value: T, status = 200, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        init: { ...init, status: init?.status ?? status },
      }),
      respond: <T>(value: T, init?: ResponseInit): ResponseResult<T> => ({
        [RESPONSE_RESULT]: true,
        body: value,
        ...(init ? { init } : {}),
      }),
    };
    const result = await route.handler(routeContext);
    return await this.#toResponse(result, route);
  }

  async #authenticate(request: Request, route: AnyRouteDefinition): Promise<Identity | null> {
    if (!isProtectedAuth(route.auth)) return null;
    const provider = this.#host.authProvider();
    if (!provider) throw new ConfigurationError("No auth provider is configured.");
    const identity = await provider.authenticate(request);
    const required = route.auth.required !== false;
    if (!identity && required) throw new UnauthorizedError();
    if (identity && route.auth.scopes) {
      const hasAllScopes = route.auth.scopes.every((scope) => identity.scopes.includes(scope));
      if (!hasAllScopes) throw new ForbiddenError();
    }
    return identity;
  }

  async #toResponse(result: unknown, route: AnyRouteDefinition): Promise<Response> {
    let body = result;
    const defaultStatus = route.responseStatus ??
      (route.method === "post" ? 201 : route.method === "delete" ? 204 : 200);
    let init: ResponseInit = { status: defaultStatus };
    if (isResponseResult(result)) {
      body = result.body;
      init = result.init ?? init;
    }
    const status = result instanceof Response ? result.status : init.status ?? defaultStatus;

    const declaredResponses = route.responses;
    if (declaredResponses && !Object.hasOwn(declaredResponses, status)) {
      if (result instanceof Response) discardResponseBody(result);
      throw new ResponseContractError(
        `Response status ${status} is not declared for '${route.method.toUpperCase()} ${route.path}'.`,
        { status, declaredStatuses: Object.keys(declaredResponses).map(Number) },
      );
    }
    if (result instanceof Response) return result;

    const responseSchemas = extractResponseSchemas(route);
    const hasResponseContract = declaredResponses !== undefined;
    if (status === 204 && body !== undefined) {
      throw new ResponseContractError("A 204 response must not include a response body.", {
        status,
      });
    }
    if (hasResponseContract && status !== 204 && body === undefined) {
      throw new ResponseContractError(
        `Response status ${status} requires a response body for '${route.method.toUpperCase()} ${route.path}'.`,
        { status },
      );
    }
    const schemaToValidate = responseSchemas[status];
    if (schemaToValidate && body !== undefined) {
      body = this.#host.validator.validate(schemaToValidate, body, "response");
    }

    if (body === undefined || status === 204) {
      return new Response(null, { ...init, status: 204 });
    }
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=UTF-8");
    }
    return new Response(JSON.stringify(body), { ...init, status, headers });
  }
}
