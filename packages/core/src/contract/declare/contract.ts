import type { TObject, TSchema } from "typebox";
import type { HttpMethod } from "../../base/http.ts";
import type { CheckedOperations } from "./path_types.ts";
import type { NamedResponse, ResponseSpec } from "./response.ts";
import type { Requirement, Schemes, Security } from "./security.ts";

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
