// Types that HyAPI infers from contracts, so that handlers are checked against them. These are the
// generics that carry a contract's literal declarations to its handlers; everything else in Core
// should not need generics.
import type { Static, TObject, TSchema } from "typebox";
import type { AnyContract, Contract } from "./define.ts";
import type { NamedResponse } from "./response.ts";
import type { IdentityOf, Schemes } from "./security.ts";

type SchemaLike = { readonly "~kind": unknown };
type StaticOf<Schema> = Schema extends TSchema ? Static<Schema> : never;

// Parameters with a `default` (declared with `T.With(schema, { default })`) are filled in by the
// runtime when absent, so they are required in handler input.
type DefaultKeys<Properties> = {
  [Name in keyof Properties]: Properties[Name] extends { readonly default: unknown } ? Name : never;
}[keyof Properties];
// `[Keys] extends [never]` asks "are there no keys?" without distributing over the union of keys.
type RequireKeys<Value, Keys extends PropertyKey> = [Keys] extends [never] ? Value
  :
    & Omit<Value, Keys>
    & { readonly [Name in Keys & keyof Value]-?: Exclude<Value[Name], undefined> };
type ParameterInput<Schema> = Schema extends TObject<infer Properties>
  ? RequireKeys<Static<Schema>, DefaultKeys<Properties>>
  : StaticOf<Schema>;

/** The body schema of a declaration: a schema, or the `schema` of `{ schema, mediaType, ... }`. */
type BodySchemaOf<Declaration> = Declaration extends SchemaLike ? Declaration
  : Declaration extends { readonly schema: infer Schema } ? Schema
  : never;
// Bodies that are neither JSON nor text reach the handler as bytes (RFC 0001 A24).
// `string extends MediaType` is true when the media type is not a literal, so it is unknown.
type IsBytes<MediaType> = string extends MediaType ? false
  : MediaType extends "application/json" | `${string}+json` | `text/${string}` ? false
  : true;
type BodyValue<Declaration> = Declaration extends { readonly mediaType: infer MediaType }
  ? IsBytes<MediaType> extends true ? Uint8Array : StaticOf<BodySchemaOf<Declaration>>
  : StaticOf<BodySchemaOf<Declaration>>;
type BodyInput<Declaration> = Declaration extends { readonly required: false }
  ? { readonly body?: BodyValue<Declaration> }
  : { readonly body: BodyValue<Declaration> };

// An operation without inputs gets an empty object, so `({}, ctx) => ...` type-checks.
// deno-lint-ignore ban-types
type NoInput = {};

/**
 * The validated input a handler receives for an operation. Only declared locations appear.
 *
 * @typeParam Operation - One operation declaration of a contract.
 */
export type InputOf<Operation> =
  & NoInput
  & (Operation extends { readonly params: infer Params } ? { readonly params: StaticOf<Params> }
    : unknown)
  & (Operation extends { readonly query: infer Query } ? { readonly query: ParameterInput<Query> }
    : unknown)
  & (Operation extends { readonly headers: infer Headers }
    ? { readonly headers: ParameterInput<Headers> }
    : unknown)
  & (Operation extends { readonly cookies: infer Cookies }
    ? { readonly cookies: ParameterInput<Cookies> }
    : unknown)
  & (Operation extends { readonly body: infer Body } ? BodyInput<Body> : unknown);

type SpecResult<Status, Spec> =
  & { readonly status: Status }
  & (Spec extends { readonly body: infer Body } ? { readonly body: StaticOf<Body> }
    : { readonly body?: undefined })
  & (Spec extends { readonly headers: infer Headers } ? { readonly headers: StaticOf<Headers> }
    : { readonly headers?: Readonly<Record<string, string>> });

/** The result for one declared status: a named response, a bare schema, or the full form. */
type ResultFor<Status, Declared> = Declared extends NamedResponse<infer Spec>
  ? SpecResult<Status, Spec>
  : Declared extends SchemaLike ? {
      readonly status: Status;
      readonly body: StaticOf<Declared>;
      readonly headers?: Readonly<Record<string, string>>;
    }
  : SpecResult<Status, Declared>;

type ResponsesOf<Operation> = Operation extends { readonly responses: infer Responses } ? Responses
  : never;

/**
 * The union of results a handler may return for an operation, one member per declared status.
 *
 * @typeParam Operation - One operation declaration of a contract.
 */
export type ResultOf<Operation> = {
  [Status in keyof ResponsesOf<Operation>]: ResultFor<Status, ResponsesOf<Operation>[Status]>;
}[keyof ResponsesOf<Operation>];

type AlternativeIdentity<Alternative, SchemeSet extends Schemes> = {
  readonly [Name in keyof Alternative & keyof SchemeSet]: IdentityOf<SchemeSet[Name]>;
};
// One union member per alternative; `[Alternative] extends [never]` is the empty list, `[]`.
type FromRequirements<Requirements, SchemeSet extends Schemes> = Requirements extends
  readonly (infer Alternative)[] ? [Alternative] extends [never] ? undefined
  : Alternative extends unknown ? AlternativeIdentity<Alternative, SchemeSet>
  : never
  : never;
type Inherited<SchemeSet extends Schemes> = [keyof SchemeSet] extends [never] ? undefined
  : { readonly [Name in keyof SchemeSet]?: IdentityOf<SchemeSet[Name]> } | undefined;

/**
 * The security result for an operation: a union with one member per alternative, each holding
 * the identity of every scheme in it. `undefined` for public operations. An operation that
 * inherits the API root requirement gets every scheme as optional.
 *
 * @typeParam Operation - One operation declaration of a contract.
 * @typeParam SchemeSet - The contract's security schemes by name.
 * @typeParam DefaultSecurity - The contract's default requirement, or `undefined`.
 */
export type SecurityOf<Operation, SchemeSet extends Schemes, DefaultSecurity = undefined> =
  Operation extends { readonly security: infer Requirements }
    ? FromRequirements<Requirements, SchemeSet>
    : DefaultSecurity extends readonly unknown[] ? FromRequirements<DefaultSecurity, SchemeSet>
    : Inherited<SchemeSet>;

/**
 * The declaration of one operation of a contract.
 *
 * @typeParam Resource - The contract, as `typeof contract`.
 * @typeParam OperationId - The operation's `operationId`.
 */
export type OperationOf<
  Resource extends AnyContract,
  OperationId extends keyof Resource["operations"],
> = Resource["operations"][OperationId];

/**
 * The security result type of one operation of a contract.
 *
 * @typeParam Resource - The contract, as `typeof contract`.
 * @typeParam OperationId - The operation's `operationId`.
 */
export type SecurityFor<
  Resource extends AnyContract,
  OperationId extends keyof Resource["operations"],
> = Resource extends Contract<infer SchemeSet, infer Operations, infer DefaultSecurity>
  ? SecurityOf<Operations[OperationId & keyof Operations], SchemeSet, DefaultSecurity>
  : never;
