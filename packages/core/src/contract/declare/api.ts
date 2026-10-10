import type { ApiInfo, ServerSpec, TagSpec } from "../model.ts";
import type { AnyContract } from "./contract.ts";
import type { Requirement, Schemes, Security } from "./security.ts";

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
