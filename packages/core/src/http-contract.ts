import type {
  HttpMethod,
  InferSchema,
  MaybePromise,
  PortVersion,
  RequestContext,
  ResponseSchemas,
  RouteDefinition,
  RouteGroupApi,
  RouteMetadata,
  RouteRequestSchemas,
  Schema,
} from "./types.ts";
import { SchemaValidator } from "./validation.ts";
import { type ResiliencePolicy, withResilience } from "./resilience.ts";

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
  readonly version: PortVersion;
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
  HttpContractRoute<infer TParams, infer TQuery, infer TBody, infer _TResponses, infer _TRequired>
  ? RequestPart<"params", TParams> & RequestPart<"query", TQuery> & RequestPart<"body", TBody>
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
  readonly retry?: HttpRetryOptions;
  readonly resilience?: ResiliencePolicy;
  readonly deadline?: number;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => MaybePromise<Response>;
}

export interface HttpRetryOptions {
  readonly maxAttempts: number;
  readonly delayMs?: number;
  readonly backoff?: "exponential";
  readonly maxDelayMs?: number;
  readonly jitter?: boolean;
}

export interface HttpPropagationSource {
  readonly request: Request;
  readonly requestId: string;
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
type ResilienceGuard = (invocation: HttpInvocation) => Promise<HttpInvocationResult>;

export class HttpContractClientError extends Error {
  constructor(
    readonly operation: string,
    readonly reason: "network" | "timeout" | "client" | "server" | "contract",
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
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("HTTP contract clients require a positive timeoutMs.");
  }
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
    throw new Error("HTTP contract client deadline must be finite.");
  }
  const maxAttempts = options.retry?.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("HTTP retry maxAttempts must be a positive integer.");
  }
  if (
    options.retry?.delayMs !== undefined &&
    (!Number.isFinite(options.retry.delayMs) || options.retry.delayMs < 0)
  ) {
    throw new Error("HTTP retry delayMs must be non-negative.");
  }
  if (
    options.retry?.maxDelayMs !== undefined &&
    (!Number.isFinite(options.retry.maxDelayMs) || options.retry.maxDelayMs < 0)
  ) {
    throw new Error("HTTP retry maxDelayMs must be non-negative.");
  }
  const validator = new SchemaValidator();
  const resilienceGuard = options.resilience ? createResilienceGuard(options) : undefined;
  const invoke = async (
    name: string,
    route: AnyHttpContractRoute,
    request: HttpClientRequest,
    init?: RequestInit,
  ): Promise<HttpContractResponse<ResponseSchemas>> => {
    const url = new URL(interpolatePath(route.path, request.params), options.baseUrl);
    appendQuery(url, request.query);
    const headers = new Headers(init?.headers);
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const deadline = resolveDeadline(
      options.deadline,
      parseDeadline(headers.get("x-hyapi-deadline")),
    );
    const invocation: HttpInvocation = {
      name,
      route,
      url,
      headers,
      body,
      init,
      options,
      validator,
      deadline,
    };
    if (resilienceGuard) {
      return await runResilienceRetry(resilienceGuard, invocation, options.resilience?.retry);
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await invokeOnce(
          name,
          route,
          url,
          headers,
          body,
          init,
          options,
          validator,
          deadline,
        );
      } catch (error) {
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new HttpContractClientError(name, "timeout", undefined, { cause: error });
        }
        if (!isRetryable(error, route.method, headers) || attempt === maxAttempts) throw error;
        const baseDelay = options.retry?.backoff === "exponential"
          ? (options.retry?.delayMs ?? 0) * 2 ** (attempt - 1)
          : options.retry?.delayMs ?? 0;
        const cappedDelay = Math.min(baseDelay, options.retry?.maxDelayMs ?? baseDelay);
        const delayMs = options.retry?.jitter
          ? Math.floor(Math.random() * (cappedDelay + 1))
          : cappedDelay;
        if (delayMs > 0) {
          if (deadline !== undefined && Date.now() + delayMs >= deadline) {
            throw new HttpContractClientError(name, "timeout", undefined, { cause: error });
          }
          await delay(delayMs);
        }
      }
    }
    throw new Error("HTTP retry loop ended unexpectedly.");
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
  headers.set("x-request-id", source.requestId);
  const traceparent = source.request.headers.get("traceparent");
  if (traceparent) headers.set("traceparent", traceparent);
  headers.set("x-hyapi-service", serviceName);
  if (source.deadline !== undefined && Number.isFinite(source.deadline)) {
    headers.set("x-hyapi-deadline", String(source.deadline));
  }
  return { ...init, headers };
}

function createResilienceGuard(
  options: HttpContractClientOptions,
): ResilienceGuard {
  const resilience = options.resilience!;
  validateResilienceRetryPolicy(resilience.retry);
  const guardPolicy: ResiliencePolicy = {
    ...(resilience.timeoutMs === undefined ? {} : { timeoutMs: resilience.timeoutMs }),
    ...(resilience.circuitBreaker === undefined
      ? {}
      : { circuitBreaker: resilience.circuitBreaker }),
    ...(resilience.bulkhead === undefined ? {} : { bulkhead: resilience.bulkhead }),
  };
  return withResilience(
    (invocation: HttpInvocation) =>
      invokeOnce(
        invocation.name,
        invocation.route,
        invocation.url,
        invocation.headers,
        invocation.body,
        invocation.init,
        invocation.options,
        invocation.validator,
        invocation.deadline,
      ),
    guardPolicy,
  );
}

async function runResilienceRetry(
  operation: ResilienceGuard,
  invocation: HttpInvocation,
  policy: ResiliencePolicy["retry"] | undefined,
): Promise<HttpInvocationResult> {
  if (!policy) return await operation(invocation);
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation(invocation);
    } catch (error) {
      lastError = error;
      if (invocation.deadline !== undefined && Date.now() >= invocation.deadline) {
        throw new HttpContractClientError(invocation.name, "timeout", undefined, { cause: error });
      }
      if (attempt === policy.maxAttempts) throw error;
      const retryOn = policy.retryOn?.(error) ??
        isRetryable(error, invocation.route.method, invocation.headers);
      if (!retryOn) throw error;
      const baseDelay = policy.backoff === "exponential"
        ? policy.initialDelayMs * 2 ** (attempt - 1)
        : policy.initialDelayMs;
      const cappedDelay = Math.min(baseDelay, policy.maxDelayMs ?? baseDelay);
      const delayMs = policy.jitter ? Math.floor(Math.random() * (cappedDelay + 1)) : cappedDelay;
      if (delayMs > 0) {
        if (
          invocation.deadline !== undefined &&
          Date.now() + delayMs >= invocation.deadline
        ) {
          throw new HttpContractClientError(invocation.name, "timeout", undefined, {
            cause: error,
          });
        }
        await delay(delayMs);
      }
    }
  }
  throw lastError;
}

function validateResilienceRetryPolicy(policy: ResiliencePolicy["retry"] | undefined): void {
  if (!policy) return;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error("Resilience retry maxAttempts must be a positive integer.");
  }
  if (!Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs < 0) {
    throw new Error("Resilience retry initialDelayMs must be non-negative.");
  }
  if (
    policy.maxDelayMs !== undefined &&
    (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < 0)
  ) {
    throw new Error("Resilience retry maxDelayMs must be non-negative.");
  }
}

async function invokeOnce(
  name: string,
  route: AnyHttpContractRoute,
  url: URL,
  headers: Headers,
  body: string | undefined,
  init: RequestInit | undefined,
  options: HttpContractClientOptions,
  validator: SchemaValidator,
  deadline: number | undefined,
): Promise<HttpContractResponse<ResponseSchemas>> {
  const remaining = deadline === undefined
    ? options.timeoutMs
    : Math.min(options.timeoutMs, deadline - Date.now());
  if (remaining <= 0) throw new HttpContractClientError(name, "timeout");
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), Math.max(1, Math.ceil(remaining)));
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;
  const requestInit: RequestInit = {
    ...init,
    headers,
    signal,
    ...(body === undefined ? {} : { body }),
  };
  try {
    const response = await (options.fetch ?? fetch)(url, requestInit);
    if (timeoutController.signal.aborted) {
      throw new HttpContractClientError(name, "timeout");
    }
    const schema = route.responses[response.status];
    if (!schema) {
      const reason = response.status >= 500
        ? "server"
        : response.status >= 400
        ? "client"
        : "contract";
      throw new HttpContractClientError(name, reason, response.status);
    }

    let result: unknown;
    if (response.status !== 204 && response.headers.get("content-length") !== "0") {
      try {
        result = await response.json();
      } catch (error) {
        throw new HttpContractClientError(name, "contract", response.status, { cause: error });
      }
    }
    try {
      result = validator.validate(schema, result, "response");
    } catch (error) {
      throw new HttpContractClientError(name, "contract", response.status, { cause: error });
    }
    if (timeoutController.signal.aborted) {
      throw new HttpContractClientError(name, "timeout");
    }
    return { status: response.status, body: result } as HttpContractResponse<ResponseSchemas>;
  } catch (error) {
    if (error instanceof HttpContractClientError) throw error;
    throw new HttpContractClientError(
      name,
      timeoutController.signal.aborted ? "timeout" : "network",
      undefined,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseDeadline(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const deadline = Number(value);
  return Number.isFinite(deadline) ? deadline : undefined;
}

function resolveDeadline(...deadlines: Array<number | undefined>): number | undefined {
  const valid = deadlines.filter((deadline): deadline is number => deadline !== undefined);
  return valid.length === 0 ? undefined : Math.min(...valid);
}

function isRetryable(error: unknown, method: HttpMethod, headers: Headers): boolean {
  if (!(error instanceof HttpContractClientError)) return false;
  const idempotent = method === "get" || method === "put" || method === "delete" ||
    method === "options";
  return idempotent || headers.has("idempotency-key")
    ? error.reason === "network" || error.reason === "timeout" || error.reason === "server"
    : false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
