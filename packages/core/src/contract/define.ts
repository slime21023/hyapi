import type { TObject, TSchema } from "typebox";
import type { NamedResponse, ResponseSpec } from "./response.ts";
import type { Requirement, Schemes, Security } from "./security.ts";

/** HTTP methods that an operation may declare. */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "TRACE";

/** Serialization of one parameter. Only the v1 subset of OpenAPI styles is accepted. */
export interface StyleOverrides {
  readonly params?: Readonly<
    Record<string, { readonly style?: "simple"; readonly explode?: boolean }>
  >;
  readonly query?: Readonly<
    Record<string, { readonly style?: "form" | "deepObject"; readonly explode?: boolean }>
  >;
  readonly headers?: Readonly<
    Record<string, { readonly style?: "simple"; readonly explode?: boolean }>
  >;
  readonly cookies?: Readonly<
    Record<string, { readonly style?: "form"; readonly explode?: boolean }>
  >;
}

/** A request body: a schema (required JSON), or the full form. */
export type BodySpec = TSchema | {
  readonly schema: TSchema;
  readonly mediaType?: string;
  readonly required?: boolean;
  readonly description?: string;
};

/** A declared response: a schema (JSON body), the full form, or a named response. */
export type ResponseValue = TSchema | ResponseSpec | NamedResponse;

/** One operation of a contract. */
export interface OperationSpec<S extends Schemes = Schemes> {
  readonly method: HttpMethod;
  /** An OpenAPI path template such as `/users/{id}`. */
  readonly path: string;
  readonly params?: TObject;
  readonly query?: TObject;
  readonly headers?: TObject;
  readonly cookies?: TObject;
  readonly styles?: StyleOverrides;
  readonly body?: BodySpec;
  readonly responses: { readonly [status: number]: ResponseValue };
  /** Alternatives (OR) of requirements (AND). `[]` marks a public operation. */
  readonly security?: readonly Requirement<S>[];
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
}

/** Operations keyed by `operationId`. */
export type OperationMap<S extends Schemes = Schemes> = Readonly<Record<string, OperationSpec<S>>>;

/** A resource contract created by {@link defineContract}. */
export interface Contract<
  S extends Schemes = Schemes,
  Ops = OperationMap<S>,
  Sec = undefined,
> {
  readonly kind: "hyapi.contract";
  readonly securitySchemes?: Security<S>;
  readonly security?: Sec;
  readonly tags?: readonly string[];
  readonly operations: Ops;
}

// deno-lint-ignore no-explicit-any
export type AnyContract = Contract<any, any, any>;

// --- Type-level path checks ----------------------------------------------------------------------

/** Extracts `{name}` parameters from a path template. */
export type PathParams<P extends string> = P extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PathParams<Rest>
  : never;

type ParamKeys<Op> = Op extends { readonly params: TObject<infer Props> } ? keyof Props & string
  : never;
type PathOf<Op> = Op extends { readonly path: infer P extends string } ? P : string;
type Missing<Op> = Exclude<PathParams<PathOf<Op>>, ParamKeys<Op>>;
type Extra<Op> = Exclude<ParamKeys<Op>, PathParams<PathOf<Op>>>;

/** Adds an impossible required property that names the mismatch, so the editor reports it. */
type CheckOperation<Op> = [Missing<Op>] extends [never] ? [Extra<Op>] extends [never] ? unknown
  : { readonly [K in `params not in the path: ${Extra<Op>}`]: never }
  : { readonly [K in `path parameters missing from params: ${Missing<Op>}`]: never };

type CheckedOperations<Ops> = { readonly [K in keyof Ops]: CheckOperation<Ops[K]> };

/**
 * Declares the operations of one resource, keyed by `operationId`.
 *
 * `security` is the resource default that operations inherit unless they declare their own; the
 * API root requirement applies when neither does.
 */
export function defineContract<
  const Ops extends OperationMap<S>,
  // deno-lint-ignore ban-types
  S extends Schemes = {},
  const Sec extends readonly Requirement<S>[] | undefined = undefined,
>(contract: {
  readonly securitySchemes?: Security<S>;
  readonly security?: Sec;
  readonly tags?: readonly string[];
  readonly operations: Ops & CheckedOperations<Ops>;
}): Contract<S, Ops, Sec> {
  return Object.freeze({ kind: "hyapi.contract", ...contract }) as Contract<S, Ops, Sec>;
}

// --- API -----------------------------------------------------------------------------------------

/** API metadata emitted as the OpenAPI `info` object. */
export interface ApiInfo {
  readonly title: string;
  readonly version: string;
  readonly summary?: string;
  readonly description?: string;
  readonly termsOfService?: string;
  readonly contact?: { readonly name?: string; readonly url?: string; readonly email?: string };
  readonly license?: { readonly name: string; readonly identifier?: string; readonly url?: string };
}

/** A server URL emitted in the OpenAPI document. */
export interface ServerSpec {
  readonly url: string;
  readonly description?: string;
}

/** Documentation for a tag used by operations. */
export interface TagSpec {
  readonly name: string;
  readonly description?: string;
}

/** Checks for custom `format` values, keyed by format name. */
export type FormatChecks = Readonly<Record<string, (value: string) => boolean>>;

/** An API created by {@link defineApi}. */
export interface Api<S extends Schemes = Schemes, Cs = readonly AnyContract[]> {
  readonly kind: "hyapi.api";
  readonly info: ApiInfo;
  readonly servers?: readonly ServerSpec[];
  readonly tags?: readonly TagSpec[];
  readonly formats?: FormatChecks;
  readonly securitySchemes?: Security<S>;
  readonly security?: readonly Requirement<S>[];
  readonly contracts: Cs;
}

/**
 * Declares an API: its metadata, custom formats, security schemes, root security, and resource
 * contracts.
 *
 * `formats` declares checks for `format` values beyond the standard ones, such as
 * `{ isbn: (value) => isIsbn(value) }`. Format names are process-wide in TypeBox, so two APIs in
 * one process that declare the same name must use the same check.
 */
export function defineApi<
  const Cs extends readonly AnyContract[],
  // deno-lint-ignore ban-types
  S extends Schemes = {},
>(api: {
  readonly info: ApiInfo;
  readonly servers?: readonly ServerSpec[];
  readonly tags?: readonly TagSpec[];
  readonly formats?: FormatChecks;
  readonly securitySchemes?: Security<S>;
  readonly security?: readonly Requirement<S>[];
  readonly contracts: Cs;
}): Api<S, Cs> {
  return Object.freeze({ kind: "hyapi.api", ...api });
}
