import { DEADLINE_HEADER, parseDeadlineHeader } from "./deadline.ts";
import { ConfigurationError } from "./errors.ts";
import {
  computeRetryDelay,
  createGuard,
  ResilienceError,
  type ResiliencePolicy,
  type RetryPolicy,
  validateRetryPolicy,
} from "./resilience.ts";
import { MAX_TIMER_MS, sleep } from "./timers.ts";
import type {
  ContractVersion,
  HttpMethod,
  InferSchema,
  MaybePromise,
  RequestContext,
  ResponseSchemas,
  RouteDefinition,
  RouteGroupApi,
  RouteMetadata,
  RouteRequestSchemas,
  Schema,
} from "./types.ts";
import { SchemaValidator } from "./validation.ts";
import { validateContractVersion } from "./version.ts";

export interface HttpContractRoute<
  TParams extends Schema | undefined = Schema | undefined,
  TQuery extends Schema | undefined = Schema | undefined,
  TBody extends Schema | undefined = Schema | undefined,
  TResponse extends ResponseSchemas = ResponseSchemas,
  TBodyRequired extends boolean = true,
> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly request?: RouteRequestSchemas<TParams, TQuery, TBody, Schema | undefined, TBodyRequired>;
  readonly responses: TResponse;
  readonly metadata?: RouteMetadata;
}

export type AnyHttpContractRoute = HttpContractRoute<
  Schema | undefined,
  Schema | undefined,
  Schema | undefined,
  ResponseSchemas,
  boolean
>;

export type HttpContractRoutes = Readonly<Record<string, AnyHttpContractRoute>>;

export interface HttpContract<TRoutes extends HttpContractRoutes = HttpContractRoutes> {
  readonly name: string;
  readonly version: ContractVersion;
  readonly routes: TRoutes;
}

export type HttpContractHandler<TRoute extends AnyHttpContractRoute> = TRoute extends
  HttpContractRoute<
    infer TParams,
    infer TQuery,
    infer TBody,
    infer _TResponse,
    infer TBodyRequired
  > ? (context: RequestContext<TParams, TQuery, TBody, TBodyRequired>) => MaybePromise<unknown>
  : never;

export type HttpContractHandlers<TRoutes extends HttpContractRoutes> = {
  readonly [TName in keyof TRoutes]: HttpContractHandler<TRoutes[TName]>;
};

type RequestPart<TKey extends string, TValue> = TValue extends Schema
  ? { readonly [TName in TKey]: InferSchema<TValue> }
  : { readonly [TName in TKey]?: never };

export type HttpContractRequest<TRoute extends AnyHttpContractRoute> = TRoute extends
  HttpContractRoute<infer TParams, infer TQuery, infer TBody, infer _TResponses, infer TRequired> ?
    & RequestPart<"params", TParams>
    & RequestPart<"query", TQuery>
    & ((TRoute extends { readonly request: { readonly bodyRequired: false } } ? false
      : TRequired) extends false ? Partial<RequestPart<"body", TBody>>
      : RequestPart<"body", TBody>)
  : never;

type HttpContractResponse<TResponses extends ResponseSchemas> = {
  readonly [TStatus in keyof TResponses]: {
    readonly status: TStatus extends number ? TStatus : never;
    readonly body: InferSchema<TResponses[TStatus] & Schema>;
  };
}[keyof TResponses];

export type HttpContractClient<TRoutes extends HttpContractRoutes> = {
  readonly [TName in keyof TRoutes]: (
    request: HttpContractRequest<TRoutes[TName]>,
    init?: RequestInit,
  ) => Promise<HttpContractResponse<TRoutes[TName]["responses"]>>;
};

export interface HttpContractClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly resilience?: ResiliencePolicy;
  readonly deadline?: number;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => MaybePromise<Response>;
}

export interface HttpPropagationSource {
  readonly request: Request;
  readonly requestId: string;
  readonly requestIdHeader?: string;
  readonly deadline?: number;
}

interface HttpClientRequest {
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
}

interface HttpInvocation {
  readonly name: string;
  readonly route: AnyHttpContractRoute;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly init: RequestInit | undefined;
  readonly options: HttpContractClientOptions;
  readonly validator: SchemaValidator;
  readonly deadline: number | undefined;
}

type HttpInvocationResult = HttpContractResponse<ResponseSchemas>;
type HttpAttempt = (invocation: HttpInvocation) => Promise<HttpInvocationResult>;

export class HttpContractClientError extends Error {
  constructor(
    readonly operation: string,
    readonly reason:
      | "network"
      | "timeout"
      | "deadline"
      | "aborted"
      | "client"
      | "server"
      | "contract",
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(`HTTP contract operation '${operation}' failed: ${reason}.`, options);
    this.name = "HttpContractClientError";
  }
}

export function defineHttpContract<TRoutes extends HttpContractRoutes>(
  contract: HttpContract<TRoutes>,
): HttpContract<TRoutes> {
  validateContractVersion(contract.version);
  for (const [key, route] of Object.entries(contract.routes)) {
    if (!route.path.startsWith("/")) {
      throw new ConfigurationError(
        `HTTP contract '${contract.name}' route '${key}' path must start with '/'.`,
      );
    }
  }
  return contract;
}

export function registerHttpContract<TRoutes extends HttpContractRoutes>(
  api: RouteGroupApi,
  contract: HttpContract<TRoutes>,
  handlers: HttpContractHandlers<TRoutes>,
): void {
  for (
    const [name, contractRoute] of Object.entries(contract.routes) as [
      keyof TRoutes & string,
      AnyHttpContractRoute,
    ][]
  ) {
    const handler = handlers[name];
    if (typeof handler !== "function") {
      throw new ConfigurationError(
        `HTTP contract '${contract.name}' has no handler for route '${name}'.`,
      );
    }
    const metadata = {
      ...contractRoute.metadata,
      operationId: contractRoute.metadata?.operationId ?? name,
    };
    api.route({
      ...contractRoute,
      metadata,
      handler,
    } as unknown as RouteDefinition);
  }
}

export function createHttpContractClient<TRoutes extends HttpContractRoutes>(
  contract: HttpContract<TRoutes>,
  options: HttpContractClientOptions,
): HttpContractClient<TRoutes> {
  if (
    !Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 ||
    options.timeoutMs > MAX_TIMER_MS
  ) {
    throw new Error("HTTP contract clients require a positive timeoutMs of at most 2147483647.");
  }
  if (
    options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline < 0)
  ) {
    throw new Error(
      "HTTP contract client deadline must be a finite, non-negative epoch millisecond value.",
    );
  }
  const resilience = options.resilience;
  const retryPolicy = resilience?.retry;
  validateRetryPolicy(retryPolicy);
  const validator = new SchemaValidator();
  const attempt: HttpAttempt = resilience
    ? createGuard((signal, invocation: HttpInvocation) => invokeOnce(invocation, signal), {
      ...(resilience.timeoutMs === undefined ? {} : { timeoutMs: resilience.timeoutMs }),
      ...(resilience.circuitBreaker === undefined
        ? {}
        : { circuitBreaker: resilience.circuitBreaker }),
      ...(resilience.bulkhead === undefined ? {} : { bulkhead: resilience.bulkhead }),
    })
    : (invocation) => invokeOnce(invocation);
  const invoke = async (
    name: string,
    route: AnyHttpContractRoute,
    request: HttpClientRequest,
    init?: RequestInit,
  ): Promise<HttpInvocationResult> => {
    const url = resolveContractUrl(options.baseUrl, interpolatePath(route.path, request.params));
    appendQuery(url, request.query);
    const headers = new Headers(init?.headers);
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const deadline = resolveDeadline(
      options.deadline,
      parseDeadlineHeader(headers.get(DEADLINE_HEADER)),
    );
    if (deadline !== undefined) headers.set(DEADLINE_HEADER, String(Math.floor(deadline)));
    return await runClientRetry(attempt, {
      name,
      route,
      url,
      headers,
      body,
      init,
      options,
      validator,
      deadline,
    }, retryPolicy);
  };

  return Object.fromEntries(
    Object.entries(contract.routes).map(([name, route]) => [
      name,
      (request: HttpClientRequest, init?: RequestInit) => invoke(name, route, request, init),
    ]),
  ) as unknown as HttpContractClient<TRoutes>;
}

export function withHttpContext(
  source: HttpPropagationSource,
  serviceName: string,
  init: RequestInit = {},
): RequestInit {
  if (!serviceName.trim()) throw new Error("HTTP serviceName must not be empty.");
  const headers = new Headers(init.headers);
  headers.set(source.requestIdHeader ?? "x-request-id", source.requestId);
  const traceparent = source.request.headers.get("traceparent");
  if (traceparent) headers.set("traceparent", traceparent);
  headers.set("x-hyapi-service", serviceName);
  if (source.deadline !== undefined && Number.isFinite(source.deadline)) {
    headers.set(DEADLINE_HEADER, String(Math.floor(source.deadline)));
  }
  return { ...init, headers };
}

export function resolveContractUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function runClientRetry(
  attempt: HttpAttempt,
  invocation: HttpInvocation,
  retryPolicy: RetryPolicy | undefined,
): Promise<HttpInvocationResult> {
  for (let attemptNumber = 1;; attemptNumber += 1) {
    if (invocation.init?.signal?.aborted) {
      throw new HttpContractClientError(invocation.name, "aborted");
    }
    try {
      return await attempt(invocation);
    } catch (error) {
      if (
        !retryPolicy || attemptNumber >= retryPolicy.maxAttempts ||
        !shouldRetry(error, invocation, retryPolicy)
      ) {
        throw error;
      }
      const delayMs = computeRetryDelay(retryPolicy, attemptNumber);
      if (invocation.deadline !== undefined && Date.now() + delayMs >= invocation.deadline) {
        throw new HttpContractClientError(invocation.name, "deadline", undefined, { cause: error });
      }
      if (delayMs > 0) {
        try {
          await sleep(delayMs, invocation.init?.signal ?? undefined);
        } catch {
          throw new HttpContractClientError(invocation.name, "aborted", undefined, {
            cause: error,
          });
        }
      }
    }
  }
}

function shouldRetry(error: unknown, invocation: HttpInvocation, policy: RetryPolicy): boolean {
  if (!isIdempotentRequest(invocation.route.method, invocation.headers)) return false;
  return policy.retryOn?.(error) ?? isTransientFailure(error);
}

function isIdempotentRequest(method: HttpMethod, headers: Headers): boolean {
  return method === "get" || method === "put" || method === "delete" || method === "options" ||
    headers.has("idempotency-key");
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof ResilienceError) return error.reason === "timeout";
  if (!(error instanceof HttpContractClientError)) return false;
  return error.reason === "network" || error.reason === "timeout" || error.reason === "server" ||
    (error.reason === "client" && (error.status === 408 || error.status === 429));
}

async function invokeOnce(
  invocation: HttpInvocation,
  guardSignal?: AbortSignal,
): Promise<HttpInvocationResult> {
  const { name, route, url, headers, body, init, options, validator, deadline } = invocation;
  const now = Date.now();
  const remaining = deadline === undefined
    ? options.timeoutMs
    : Math.min(options.timeoutMs, deadline - now);
  const deadlineBound = deadline !== undefined && deadline - now < options.timeoutMs;
  if (remaining <= 0) throw new HttpContractClientError(name, "deadline");
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), Math.max(1, Math.ceil(remaining)));
  const signal = AbortSignal.any([
    timeoutController.signal,
    ...(init?.signal ? [init.signal] : []),
    ...(guardSignal ? [guardSignal] : []),
  ]);
  const requestInit: RequestInit = {
    ...init,
    method: route.method.toUpperCase(),
    headers,
    signal,
    ...(body === undefined ? {} : { body }),
  };
  try {
    const response = await (options.fetch ?? fetch)(url, requestInit);
    if (timeoutController.signal.aborted) {
      throw new HttpContractClientError(name, deadlineBound ? "deadline" : "timeout");
    }
    const schema = route.responses[response.status];
    if (!schema) {
      await response.body?.cancel().catch(() => undefined);
      const reason = response.status >= 500
        ? "server"
        : response.status >= 400
        ? "client"
        : "contract";
      throw new HttpContractClientError(name, reason, response.status);
    }

    let result: unknown;
    if (response.status === 204) {
      await response.body?.cancel().catch(() => undefined);
    } else {
      const text = await response.text();
      if (text !== "") {
        try {
          result = JSON.parse(text);
        } catch (error) {
          throw new HttpContractClientError(name, "contract", response.status, { cause: error });
        }
      }
    }
    try {
      result = validator.validate(schema, result, "response");
    } catch (error) {
      throw new HttpContractClientError(name, "contract", response.status, { cause: error });
    }
    if (timeoutController.signal.aborted) {
      throw new HttpContractClientError(name, deadlineBound ? "deadline" : "timeout");
    }
    return { status: response.status, body: result } as HttpInvocationResult;
  } catch (error) {
    if (error instanceof HttpContractClientError) throw error;
    const reason = init?.signal?.aborted
      ? "aborted"
      : guardSignal?.aborted
      ? "timeout"
      : timeoutController.signal.aborted
      ? deadlineBound ? "deadline" : "timeout"
      : "network";
    throw new HttpContractClientError(name, reason, undefined, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function resolveDeadline(...deadlines: Array<number | undefined>): number | undefined {
  const valid = deadlines.filter((deadline): deadline is number => deadline !== undefined);
  return valid.length === 0 ? undefined : Math.min(...valid);
}

function interpolatePath(path: string, params: unknown): string {
  return path.replaceAll(/\{([^}]+)\}/g, (_placeholder, name: string) => {
    const value = (params as Record<string, unknown> | undefined)?.[name];
    if (value === undefined) throw new Error(`Missing path parameter '${name}'.`);
    return encodeURIComponent(String(value));
  });
}

function appendQuery(url: URL, query: unknown): void {
  if (!query || typeof query !== "object") return;
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, String(item));
    }
  }
}
