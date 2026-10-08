import type { Static, TObject, TSchema } from "typebox";
import type { AnyContract, Contract } from "./define.ts";
import type { NamedResponse } from "./response.ts";
import type { IdentityOf, Schemes } from "./security.ts";

type SchemaLike = { readonly "~kind": unknown };
type StaticOf<X> = X extends TSchema ? Static<X> : never;

// Parameters with a `default` (declared with `T.With(schema, { default })`) are filled in by the
// runtime when absent, so they are required in handler input.
type DefaultKeys<Props> = {
  [K in keyof Props]: Props[K] extends { readonly default: unknown } ? K : never;
}[keyof Props];
type RequireKeys<V, K extends PropertyKey> = [K] extends [never] ? V
  : Omit<V, K> & { readonly [P in K & keyof V]-?: Exclude<V[P], undefined> };
type ParameterInput<X> = X extends TObject<infer Props> ? RequireKeys<Static<X>, DefaultKeys<Props>>
  : StaticOf<X>;

type BodySchemaOf<B> = B extends SchemaLike ? B
  : B extends { readonly schema: infer S } ? S
  : never;
type BodyInput<B> = B extends { readonly required: false }
  ? { readonly body?: StaticOf<BodySchemaOf<B>> }
  : { readonly body: StaticOf<BodySchemaOf<B>> };

// An operation without inputs gets an empty object, so `({}, ctx) => ...` type-checks.
// deno-lint-ignore ban-types
type NoInput = {};

/** The validated input a handler receives for an operation. Only declared locations appear. */
export type InputOf<Op> =
  & NoInput
  & (Op extends { readonly params: infer P } ? { readonly params: StaticOf<P> } : unknown)
  & (Op extends { readonly query: infer Q } ? { readonly query: ParameterInput<Q> } : unknown)
  & (Op extends { readonly headers: infer H } ? { readonly headers: ParameterInput<H> } : unknown)
  & (Op extends { readonly cookies: infer C } ? { readonly cookies: ParameterInput<C> } : unknown)
  & (Op extends { readonly body: infer B } ? BodyInput<B> : unknown);

type SpecResult<Status, Spec> =
  & { readonly status: Status }
  & (Spec extends { readonly body: infer B } ? { readonly body: StaticOf<B> }
    : { readonly body?: undefined })
  & (Spec extends { readonly headers: infer H } ? { readonly headers: StaticOf<H> }
    : { readonly headers?: Readonly<Record<string, string>> });

type ResultFor<Status, R> = R extends NamedResponse<infer Spec> ? SpecResult<Status, Spec>
  : R extends SchemaLike ? {
      readonly status: Status;
      readonly body: StaticOf<R>;
      readonly headers?: Readonly<Record<string, string>>;
    }
  : SpecResult<Status, R>;

type ResponsesOf<Op> = Op extends { readonly responses: infer R } ? R : never;

/** The union of results a handler may return for an operation, one member per declared status. */
export type ResultOf<Op> = {
  [Status in keyof ResponsesOf<Op>]: ResultFor<Status, ResponsesOf<Op>[Status]>;
}[keyof ResponsesOf<Op>];

type RequirementIdentity<Alt, S extends Schemes> = {
  readonly [K in keyof Alt & keyof S]: IdentityOf<S[K]>;
};
type FromRequirements<R, S extends Schemes> = R extends readonly (infer Alt)[]
  ? [Alt] extends [never] ? undefined
  : Alt extends unknown ? RequirementIdentity<Alt, S>
  : never
  : never;
type Inherited<S extends Schemes> = [keyof S] extends [never] ? undefined
  : { readonly [K in keyof S]?: IdentityOf<S[K]> } | undefined;

/**
 * The security result for an operation: a union with one member per alternative, each holding
 * the identity of every scheme in it. `undefined` for public operations. An operation that
 * inherits the API root requirement gets every scheme as optional.
 */
export type SecurityOf<Op, S extends Schemes, Sec = undefined> = Op extends
  { readonly security: infer R } ? FromRequirements<R, S>
  : Sec extends readonly unknown[] ? FromRequirements<Sec, S>
  : Inherited<S>;

/** The operation declaration of `operationId` `K` in contract `C`. */
export type OperationOf<C extends AnyContract, K extends keyof C["operations"]> =
  C["operations"][K];

/** The security result type for `operationId` `K` in contract `C`. */
export type SecurityFor<C extends AnyContract, K extends keyof C["operations"]> = C extends
  Contract<infer S, infer Ops, infer Sec> ? SecurityOf<Ops[K & keyof Ops], S, Sec> : never;
