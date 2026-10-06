/** Normalizes application and OpenAPI configuration before startup. @module */

import { ConfigurationError } from "./errors.ts";
import type {
  OpenApiConfig,
  OpenApiConfigOptions,
  OpenApiDocument,
  OpenApiDocumentOptions,
} from "./openapi.ts";

export const DEFAULT_BODY_LIMIT_BYTES = 10_485_760;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

const DEFAULT_OPENAPI_DOCUMENT_ID = "default";
const DEFAULT_OPENAPI_PATH = "/openapi.json";

/** Fully normalized configuration used by a running application. */
export interface AppConfig {
  readonly name: string;
  readonly version: string;
  readonly environment: "development" | "test" | "production";
  readonly requestIdHeader: string;
  /** Base URL for problem `type` URIs; problems use `about:blank` when omitted. */
  readonly problemTypeBaseUrl?: string;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  /** How long `close()` waits for in-flight requests before aborting them. */
  readonly shutdownTimeoutMs?: number;
  readonly openapi: OpenApiConfig;
}

/** User-provided application configuration; omitted values receive framework defaults. */
export interface AppConfigOptions {
  readonly name: string;
  readonly version?: string;
  /**
   * Defaults to `production`. `development` adds internal error messages and details to problem
   * responses; never use it where clients are untrusted.
   */
  readonly environment?: AppConfig["environment"];
  readonly requestIdHeader?: string;
  /** Absolute base URL for problem `type` URIs, such as `https://errors.example.com`. */
  readonly problemTypeBaseUrl?: string;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly openapi?: OpenApiConfigOptions;
}

/**
 * Validates configuration and supplies application and OpenAPI defaults.
 * @param options User-provided configuration.
 */
export function defineConfig(options: AppConfigOptions): AppConfig {
  const version = options.version ?? "0.1.0";
  const requestIdHeader = options.requestIdHeader ?? "x-request-id";
  try {
    new Headers().set(requestIdHeader, "");
  } catch {
    throw new ConfigurationError("requestIdHeader must be a valid HTTP header name.");
  }
  let problemTypeBaseUrl: string | undefined;
  if (options.problemTypeBaseUrl !== undefined) {
    if (!URL.canParse(options.problemTypeBaseUrl)) {
      throw new ConfigurationError("problemTypeBaseUrl must be an absolute URL.");
    }
    problemTypeBaseUrl = options.problemTypeBaseUrl.replace(/\/+$/, "");
  }
  return {
    name: options.name,
    version,
    environment: options.environment ?? "production",
    requestIdHeader,
    ...(problemTypeBaseUrl === undefined ? {} : { problemTypeBaseUrl }),
    bodyLimitBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    openapi: normalizeOpenApiConfig(options.name, version, options.openapi),
  };
}

function normalizeOpenApiConfig(
  appName: string,
  appVersion: string,
  options: AppConfigOptions["openapi"],
): OpenApiConfig {
  const configuredDocuments: readonly OpenApiDocumentOptions[] = options?.documents ?? [{
    id: DEFAULT_OPENAPI_DOCUMENT_ID,
    path: DEFAULT_OPENAPI_PATH,
  }];
  if (configuredDocuments.length === 0) {
    throw new ConfigurationError("openapi.documents must contain at least one document.");
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const documents: OpenApiDocument[] = configuredDocuments.map((document) => {
    if (!document.id.trim()) {
      throw new ConfigurationError("OpenAPI document id must not be empty.");
    }
    if (ids.has(document.id)) {
      throw new ConfigurationError(
        `OpenAPI document '${document.id}' is registered more than once.`,
      );
    }
    if (!document.path.startsWith("/")) {
      throw new ConfigurationError(
        `OpenAPI document '${document.id}' path must start with '/'.`,
      );
    }
    if (paths.has(document.path)) {
      throw new ConfigurationError(
        `OpenAPI document path '${document.path}' is registered more than once.`,
      );
    }
    ids.add(document.id);
    paths.add(document.path);
    return {
      id: document.id,
      title: document.title ?? `${appName} API`,
      ...(document.description === undefined ? {} : { description: document.description }),
      version: document.version ?? appVersion,
      path: document.path,
    };
  });

  const defaultDocument = options?.defaultDocument ?? documents[0]!.id;
  if (!ids.has(defaultDocument)) {
    throw new ConfigurationError(
      `OpenAPI default document '${defaultDocument}' is not registered.`,
    );
  }

  return {
    enabled: options?.enabled ?? true,
    defaultDocument,
    documents,
  };
}
