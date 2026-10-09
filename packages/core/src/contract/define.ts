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

/**
 * One operation of a contract.
 *
 * @typeParam SchemeSet - The security schemes whose names `security` may use.
 */
export interface OperationSpec<SchemeSet extends Schemes = Schemes> {
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
  readonly security?: readonly Requirement<SchemeSet>[];
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
}

/** Operations keyed by `operationId`. */
type OperationMap<SchemeSet extends Schemes> = Readonly<Record<string, OperationSpec<SchemeSet>>>;

/**
 * A resource contract created by {@link defineContract}. It keeps the literal types of its
 * declarations, so that `implement` can type each handler.
 *
 * @typeParam SchemeSet - The security schemes of the API, by name.
 * @typeParam Operations - The operation declarations, keyed by `operationId`.
 * @typeParam DefaultSecurity - The contract's default requirement, or `undefined`.
 */
export interface Contract<
  SchemeSet extends Schemes = Schemes,
  Operations = OperationMap<SchemeSet>,
  DefaultSecurity = undefined,
> {
  readonly kind: "hyapi.contract";
  readonly securitySchemes?: Security<SchemeSet>;
  readonly security?: DefaultSecurity;
  readonly tags?: readonly string[];
  readonly operations: Operations;
}

// deno-lint-ignore no-explicit-any
export type AnyContract = Contract<any, any, any>;

// --- Type-level path checks ----------------------------------------------------------------------

/** Extracts `{name}` parameters from a path template. */
type PathParams<Path extends string> = Path extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PathParams<Rest>
  : never;

type ParamKeys<Operation> = Operation extends { readonly params: TObject<infer Properties> }
  ? keyof Properties & string
  : never;
type PathOf<Operation> = Operation extends { readonly path: infer Path extends string } ? Path
  : string;
type Missing<Operation> = Exclude<PathParams<PathOf<Operation>>, ParamKeys<Operation>>;
type Extra<Operation> = Exclude<ParamKeys<Operation>, PathParams<PathOf<Operation>>>;

/**
 * Adds an impossible required property that names the mismatch, so the editor reports it.
 * `[Missing<Operation>] extends [never]` asks "is nothing missing?" without distributing over the
 * union of names.
 */
type CheckOperation<Operation> = [Missing<Operation>] extends [never]
  ? [Extra<Operation>] extends [never] ? unknown
  : { readonly [Message in `params not in the path: ${Extra<Operation>}`]: never }
  : { readonly [Message in `path parameters missing from params: ${Missing<Operation>}`]: never };

type CheckedOperations<Operations> = {
  readonly [OperationId in keyof Operations]: CheckOperation<Operations[OperationId]>;
};

/**
 * Declares the operations of one resource, keyed by `operationId`.
 *
 * `security` is the resource default that operations inherit unless they declare their own; the
 * API root requirement applies when neither does.
 */
export function defineContract<
  const Operations extends OperationMap<SchemeSet>,
  // deno-lint-ignore ban-types
  SchemeSet extends Schemes = {},
  const DefaultSecurity extends readonly Requirement<SchemeSet>[] | undefined = undefined,
>(contract: {
  readonly securitySchemes?: Security<SchemeSet>;
  readonly security?: DefaultSecurity;
  readonly tags?: readonly string[];
  readonly operations: Operations & CheckedOperations<Operations>;
}): Contract<SchemeSet, Operations, DefaultSecurity> {
  return Object.freeze({ kind: "hyapi.contract", ...contract }) as Contract<
    SchemeSet,
    Operations,
    DefaultSecurity
  >;
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

/**
 * An API created by {@link defineApi}.
 *
 * @typeParam SchemeSet - The security schemes of the API, by name.
 * @typeParam Contracts - The contracts of the API, so that options can be keyed by `operationId`.
 */
export interface Api<SchemeSet extends Schemes = Schemes, Contracts = readonly AnyContract[]> {
  readonly kind: "hyapi.api";
  readonly info: ApiInfo;
  readonly servers?: readonly ServerSpec[];
  readonly tags?: readonly TagSpec[];
  readonly formats?: FormatChecks;
  readonly securitySchemes?: Security<SchemeSet>;
  readonly security?: readonly Requirement<SchemeSet>[];
  readonly contracts: Contracts;
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
  const Contracts extends readonly AnyContract[],
  // deno-lint-ignore ban-types
  SchemeSet extends Schemes = {},
>(api: {
  readonly info: ApiInfo;
  readonly servers?: readonly ServerSpec[];
  readonly tags?: readonly TagSpec[];
  readonly formats?: FormatChecks;
  readonly securitySchemes?: Security<SchemeSet>;
  readonly security?: readonly Requirement<SchemeSet>[];
  readonly contracts: Contracts;
}): Api<SchemeSet, Contracts> {
  return Object.freeze({ kind: "hyapi.api", ...api });
}
