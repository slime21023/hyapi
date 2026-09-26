export const DEFAULT_BODY_LIMIT_BYTES = 10_485_760;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface AppConfig {
  readonly name: string;
  readonly version: string;
  readonly environment: "development" | "test" | "production";
  readonly requestIdHeader: string;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  /** How long `close()` waits for in-flight requests before aborting them. */
  readonly shutdownTimeoutMs?: number;
  readonly openapi: {
    readonly enabled?: boolean;
    readonly title: string;
    readonly description?: string;
    readonly version: string;
    readonly path: string;
  };
}

export interface AppConfigOptions {
  readonly name: string;
  readonly version?: string;
  readonly environment?: AppConfig["environment"];
  readonly requestIdHeader?: string;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly openapi?: {
    readonly enabled?: boolean;
    readonly title?: string;
    readonly description?: string;
    readonly version?: string;
    readonly path?: string;
  };
}

export function defineConfig(options: AppConfigOptions): AppConfig {
  const version = options.version ?? "0.1.0";
  return {
    name: options.name,
    version,
    environment: options.environment ?? "development",
    requestIdHeader: options.requestIdHeader ?? "x-request-id",
    bodyLimitBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    openapi: {
      ...(options.openapi?.enabled === undefined ? {} : { enabled: options.openapi.enabled }),
      title: options.openapi?.title ?? `${options.name} API`,
      ...(options.openapi?.description === undefined
        ? {}
        : { description: options.openapi.description }),
      version: options.openapi?.version ?? version,
      path: options.openapi?.path ?? "/openapi.json",
    },
  };
}
