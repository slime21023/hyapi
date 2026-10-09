// Throwaway type prototype of RFC 0001 for the type-performance spike.
// Runtime behavior is intentionally minimal; only the types are under test.
import Type, { type Static, type TObject, type TSchema } from "typebox";

export { Type as T };
export type { Static } from "typebox";

type Awaitable<T> = T | Promise<T>;
type SchemaLike = { readonly "~kind": string };

// --- Named schemas and responses ---------------------------------------------------------------

const schemaName = Symbol("hyapi.schemaName");

export function defineSchema<S extends TSchema>(name: string, schema: S): S {
  Object.defineProperty(schema, schemaName, { value: name });
  return schema;
}

export const Problem = defineSchema(
  "Problem",
  Type.Object({
    type: Type.Optional(Type.String()),
    title: Type.String(),
    status: Type.Optional(Type.Integer()),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String()),
  }),
);
export type ProblemValue = Static<typeof Problem>;

export function problem(value: Omit<ProblemValue, "status">): ProblemValue {
  return value;
}

export interface ResponseSpec {
  readonly description: string;
  readonly body?: TSchema;
  readonly mediaType?: string;
  readonly headers?: TObject;
}

export interface NamedResponse<R extends ResponseSpec = ResponseSpec> {
  readonly kind: "named-response";
  readonly name: string;
  readonly spec: R;
}

export function defineResponse<const R extends ResponseSpec>(
  name: string,
  spec: R,
): NamedResponse<R> {
  return { kind: "named-response", name, spec };
}

// --- Security ------------------------------------------------------------------------------------

export interface Scheme<Identity = unknown> {
  readonly type: string;
  readonly identity?: Identity;
}
export type Schemes = Record<string, Scheme<unknown>>;

export interface Security<S extends Schemes> {
  readonly kind: "security";
  readonly schemes: S;
}

export function httpBearer<Identity>(): Scheme<Identity> {
  return { type: "http-bearer" };
}
export function apiKey<Identity>(_options: {
  readonly in: "header" | "query" | "cookie";
  readonly name: string;
}): Scheme<Identity> {
  return { type: "api-key" };
}
export function defineSecurity<const S extends Schemes>(schemes: S): Security<S> {
  return { kind: "security", schemes };
}

type IdentityOf<X> = X extends Scheme<infer I> ? I : never;
type Requirement<Names extends string> = { readonly [K in Names]?: readonly string[] };

// --- Operations and contracts --------------------------------------------------------------------

type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
type BodySpec = TSchema | {
  readonly schema: TSchema;
  readonly mediaType?: string;
  readonly required?: boolean;
  readonly description?: string;
};
type ResponseValue = TSchema | ResponseSpec | NamedResponse;

export interface OperationSpec<Names extends string = string> {
  readonly method: Method;
  readonly path: string;
  readonly params?: TObject;
  readonly query?: TObject;
  readonly headers?: TObject;
  readonly cookies?: TObject;
  readonly body?: BodySpec;
  readonly responses: { readonly [status: number]: ResponseValue };
  readonly security?: readonly Requirement<Names>[];
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
}
type Operations<Names extends string> = Record<string, OperationSpec<Names>>;

type PathParams<P extends string> = P extends `${string}{${infer N}}${infer Rest}`
  ? N | PathParams<Rest>
  : never;
type ParamKeys<Op> = Op extends { readonly params: TObject<infer Props> } ? keyof Props & string
  : never;
type PathOf<Op> = Op extends { readonly path: infer P extends string } ? P : string;
type CheckOperation<Op> = [Exclude<PathParams<PathOf<Op>>, ParamKeys<Op>>] extends [never]
  ? [Exclude<ParamKeys<Op>, PathParams<PathOf<Op>>>] extends [never] ? unknown
  : {
    readonly "params must not declare names missing from the path": Exclude<
      ParamKeys<Op>,
      PathParams<PathOf<Op>>
    >;
  }
  : {
    readonly "params must declare every path parameter": Exclude<
      PathParams<PathOf<Op>>,
      ParamKeys<Op>
    >;
  };

export interface Contract<S extends Schemes, Ops> {
  readonly kind: "contract";
  readonly securitySchemes: Security<S>;
  readonly tags?: readonly string[];
  readonly operations: Ops;
}
// deno-lint-ignore no-explicit-any
export type AnyContract = Contract<any, any>;

export function defineContract<
  S extends Schemes,
  const Ops extends Operations<keyof S & string>,
>(contract: {
  readonly securitySchemes: Security<S>;
  readonly tags?: readonly string[];
  readonly operations: Ops & { readonly [K in keyof Ops]: CheckOperation<Ops[K]> };
}): Contract<S, Ops> {
  return { kind: "contract", ...contract };
}

export interface Api<S extends Schemes, Cs> {
  readonly kind: "api";
  readonly securitySchemes: Security<S>;
  readonly contracts: Cs;
}

export function defineApi<S extends Schemes, const Cs extends readonly Contract<S, unknown>[]>(
  api: {
    readonly info: { readonly title: string; readonly version: string };
    readonly servers?: readonly { readonly url: string }[];
    readonly securitySchemes: Security<S>;
    readonly security?: readonly Requirement<keyof S & string>[];
    readonly contracts: Cs;
  },
): Api<S, Cs> {
  return { kind: "api", securitySchemes: api.securitySchemes, contracts: api.contracts };
}

// --- Inference -----------------------------------------------------------------------------------

type StaticOf<X> = X extends TSchema ? Static<X> : never;
type BodySchemaOf<B> = B extends SchemaLike ? B
  : B extends { readonly schema: infer S } ? S
  : never;
type BodyInput<B> = B extends { readonly required: false }
  ? { readonly body?: StaticOf<BodySchemaOf<B>> }
  : { readonly body: StaticOf<BodySchemaOf<B>> };

export type InputOf<Op> =
  & (Op extends { readonly params: infer P } ? { readonly params: StaticOf<P> } : unknown)
  & (Op extends { readonly query: infer Q } ? { readonly query: StaticOf<Q> } : unknown)
  & (Op extends { readonly headers: infer H } ? { readonly headers: StaticOf<H> } : unknown)
  & (Op extends { readonly cookies: infer C } ? { readonly cookies: StaticOf<C> } : unknown)
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
export type ResultOf<Op> = {
  [Status in keyof ResponsesOf<Op>]: ResultFor<Status, ResponsesOf<Op>[Status]>;
}[keyof ResponsesOf<Op>];

type SecurityFor<Op, S extends Schemes> = Op extends { readonly security: readonly (infer Alt)[] }
  ? [Alt] extends [never] ? undefined
  : Alt extends unknown ? { readonly [K in keyof Alt & keyof S]: IdentityOf<S[K]> }
  : never
  : { readonly [K in keyof S]?: IdentityOf<S[K]> };

export interface Context<Sec> {
  readonly signal: AbortSignal;
  readonly request: Request;
  readonly operationId: string;
  readonly security: Sec;
}

export type HandlerFor<Op, S extends Schemes> = (
  input: InputOf<Op>,
  ctx: Context<SecurityFor<Op, S>>,
) => Awaitable<ResultOf<Op> | Response>;

export type Handler<C extends AnyContract, K extends keyof C["operations"]> = C extends
  Contract<infer S, infer Ops> ? HandlerFor<Ops[K & keyof Ops], S> : never;

// --- Implementation and application --------------------------------------------------------------

export interface NotImplemented {
  readonly kind: "not-implemented";
}
export const notImplemented: NotImplemented = { kind: "not-implemented" };

export interface Implementation<C> {
  readonly kind: "implementation";
  readonly contract: C;
  readonly handlers: Readonly<Record<string, unknown>>;
}

export function implement<S extends Schemes, Ops>(
  contract: Contract<S, Ops>,
  handlers: NoInfer<{ readonly [K in keyof Ops]: HandlerFor<Ops[K], S> | NotImplemented }>,
): Implementation<Contract<S, Ops>> {
  return { kind: "implementation", contract, handlers };
}

export type Verifier<S extends Schemes, K extends keyof S> = (
  credential: string,
  ctx: { readonly signal: AbortSignal; readonly request: Request },
) => Awaitable<{ readonly identity: IdentityOf<S[K]>; readonly scopes: readonly string[] }>;

export interface App {
  fetch(request: Request): Promise<Response>;
}

export function createApp<S extends Schemes, Cs extends readonly Contract<S, unknown>[]>(options: {
  readonly api: Api<S, Cs>;
  readonly implementations: readonly Implementation<Cs[number]>[];
  readonly verifiers: { readonly [K in keyof S]: Verifier<S, K> };
}): Promise<App> {
  void options;
  return Promise.resolve({ fetch: () => Promise.resolve(new Response(null, { status: 501 })) });
}
