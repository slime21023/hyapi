// The options of `createApp`: their types, their defaults, and their checks, including request
// IDs. Everything here is stateless; the running application lives in app.ts.
import type { Api } from "../contract/declare/api.ts";
import type { Contract } from "../contract/declare/contract.ts";
import type { Schemes } from "../contract/declare/security.ts";
import type { StartupReport } from "./diagnostics.ts";
import type { DocumentOption } from "./documents.ts";
import type { EventListener } from "./events.ts";
import type { Implementation } from "./handler.ts";
import type { LifecycleResource } from "./lifecycle.ts";
import type { ResponseValidation } from "./respond.ts";
import type { Verifiers } from "./security.ts";

// deno-lint-ignore no-explicit-any
type SchemesOf<Definition> = Definition extends Api<infer SchemeSet, any> ? SchemeSet : Schemes;

/**
 * The `operationId`s of every contract of an API, which key per-operation options.
 *
 * @typeParam Definition - The API, as `typeof api`.
 */
// deno-lint-ignore no-explicit-any
type OperationIdsOf<Definition> = Definition extends Api<any, infer Contracts>
  ? Contracts extends readonly (infer Resource)[]
    // deno-lint-ignore no-explicit-any
    ? Resource extends Contract<any, infer Operations, any> ? keyof Operations & string : never
  : never
  : never;

/**
 * One verifier per security scheme, required when the API declares schemes.
 * `[keyof ...] extends [never]` asks "are there no schemes?" without distributing over names.
 */
type VerifierOption<Definition> = [keyof SchemesOf<Definition>] extends [never]
  ? { readonly verifiers?: Readonly<Record<string, never>> }
  : { readonly verifiers: Verifiers<SchemesOf<Definition>> };

/**
 * Options for `createApp`.
 *
 * @typeParam Definition - The API, as `typeof api`; it types verifiers and per-operation options.
 */
export type AppOptions<Definition extends Api = Api> =
  & BaseOptions<Definition>
  & VerifierOption<Definition>;

/** The options of `createApp` that do not depend on its security schemes. */
export interface BaseOptions<Definition extends Api> {
  /** The API created by `defineApi`. */
  readonly api: Definition;
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
  readonly timeouts?: { readonly [OperationId in OperationIdsOf<Definition>]?: number };
  /** Maximum request body size. Defaults to 1 MiB. */
  readonly bodyLimitBytes?: number;
  /** Per-operation body limits that override `bodyLimitBytes`, for operations with a body. */
  readonly bodyLimits?: { readonly [OperationId in OperationIdsOf<Definition>]?: number };
  /** Resources started in order before the app is returned, and stopped in reverse on close. */
  readonly lifecycle?: readonly LifecycleResource[];
  /** Receives read-only events. Without it, problem events are written with `console.warn`. */
  readonly onEvent?: EventListener;
  /**
   * Budget for `close()`: draining requests, then stopping lifecycle resources, each gets this
   * long. Defaults to 10 000 ms.
   */
  readonly shutdownTimeoutMs?: number;
  /**
   * Serves emitted OpenAPI documents, each at an explicit path. Off unless set. Text content is
   * served as given; other content is served as JSON. The content type follows the path (`.yaml`
   * and `.yml` are YAML) unless `contentType` is given.
   */
  readonly documents?: readonly DocumentOption[];
  /**
   * Gives every request an ID for events, handlers, and verifiers, and returns it in a response
   * header. Off unless set. `true` uses the `x-request-id` header and never trusts incoming IDs;
   * with `trustIncoming`, a well-formed incoming ID is reused.
   */
  readonly requestId?: boolean | { readonly header?: string; readonly trustIncoming?: boolean };
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Incoming IDs that are reused: short, and safe to log and to echo in a header. */
const INCOMING_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface RequestIdSettings {
  readonly header: string;
  readonly trustIncoming: boolean;
}

function readRequestId(
  option: BaseOptions<Api>["requestId"],
  error: StartupReport,
): RequestIdSettings | undefined {
  if (option === undefined || option === false) return undefined;
  const { header = "x-request-id", trustIncoming = false } = option === true ? {} : option;
  if (typeof header !== "string" || !HEADER_NAME.test(header)) {
    error("invalid-option", "requestId.header must be an HTTP header name");
  }
  return { header: String(header).toLowerCase(), trustIncoming: trustIncoming === true };
}

/** Applies the defaults of `createApp`'s options and reports invalid values. */
export function readSettings(options: BaseOptions<Api>, error: StartupReport) {
  const development = options.development ?? false;
  const settings = {
    development,
    responseValidation: options.responseValidation ?? (development ? "enforce" : "log"),
    bodyLimitBytes: options.bodyLimitBytes ?? 1_048_576,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
    requestId: readRequestId(options.requestId, error),
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

/** The options of `createApp` with their defaults applied. */
export type Settings = ReturnType<typeof readSettings>;

/** The ID of one request: a trusted, well-formed incoming one, or a new UUID. */
export function requestIdOf(request: Request, settings: RequestIdSettings): string {
  const incoming = settings.trustIncoming ? request.headers.get(settings.header) : null;
  return incoming !== null && INCOMING_ID.test(incoming) ? incoming : crypto.randomUUID();
}
