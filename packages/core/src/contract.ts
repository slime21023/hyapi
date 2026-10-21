import type {
  Container,
  DependenciesMap,
  Lifetime,
  Spec,
  WithRequirements,
} from "@inferdi/inferdi";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export type Schema = StandardSchemaV1;
export type SchemaOutput<S> = S extends Schema ? StandardSchemaV1.InferOutput<S> : unknown;
type OptionalSchema = Schema | undefined;
type ResponseSchemas = Schema | Readonly<Record<number, Schema>>;

/** A narrow bound that retains each InferDI graph instead of widening its generic registry. */
export interface RootContainer {
  createScope(): { dispose(): Promise<void> };
  dispose(): Promise<void>;
}

type RequiredBy<S> = S extends WithRequirements<Spec<unknown, Lifetime>, infer Keys> ? Keys : never;
type WithIdentity<T extends DependenciesMap> = {
  [Key in keyof T]: WithRequirements<T[Key], Exclude<RequiredBy<T[Key]>, "identity">>;
};
type Scope<C extends RootContainer, I> =
  C extends Container<infer Graph>
    ? Container<I extends undefined ? Graph : WithIdentity<Graph>>
    : ReturnType<C["createScope"]>;

/** Validation has already completed before either authorize or handler runs. */
export interface RouteContext<
  C extends RootContainer,
  I,
  Params extends OptionalSchema,
  Query extends OptionalSchema,
  Body extends OptionalSchema,
  Scoped extends boolean,
> {
  readonly request: Request;
  readonly root: C;
  readonly identity: I;
  readonly params: Params extends Schema ? SchemaOutput<Params> : Record<string, string>;
  readonly query: Query extends Schema ? SchemaOutput<Query> : Record<string, string>;
  readonly body: SchemaOutput<Body>;
  readonly scope: Scoped extends true ? Scope<C, I> : never;
}

export const replyBrand = Symbol("hyapi.reply");

/** Non-default statuses must be declared by the route's response schemas. */
export interface Reply<Status extends number, Value> {
  readonly status: Status;
  readonly value: Value;
  readonly [replyBrand]: true;
}

export type HandlerResult<R extends ResponseSchemas | undefined> = R extends Schema
  ? SchemaOutput<R> | Response
  : R extends Readonly<Record<number, Schema>>
    ? | { [K in keyof R & number]: Reply<K, SchemaOutput<R[K]>> }[keyof R & number]
      | (200 extends keyof R ? SchemaOutput<R[200]> : never)
      | Response
    : unknown;

export interface RouteOptions<
  C extends RootContainer,
  I,
  Params extends OptionalSchema = undefined,
  Query extends OptionalSchema = undefined,
  Body extends OptionalSchema = undefined,
  R extends ResponseSchemas | undefined = undefined,
  Scoped extends boolean = false,
> {
  readonly params?: Params;
  readonly query?: Query;
  readonly body?: Body;
  readonly response?: R;
  readonly scoped?: Scoped;
  readonly authorize?: (
    context: RouteContext<C, I, Params, Query, Body, Scoped>,
  ) => void | Promise<void>;
  readonly handler: (
    context: RouteContext<C, I, Params, Query, Body, Scoped>,
  ) => HandlerResult<R> | Promise<HandlerResult<R>>;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

export interface RouteDefinition {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly options: RouteOptions<
    RootContainer,
    unknown,
    Schema,
    Schema,
    Schema,
    ResponseSchemas,
    boolean
  >;
}

type RouteMethod<C extends RootContainer, I> = <
  const P extends string,
  Params extends OptionalSchema = undefined,
  Query extends OptionalSchema = undefined,
  Body extends OptionalSchema = undefined,
  R extends ResponseSchemas | undefined = undefined,
  Scoped extends boolean = false,
>(
  path: P,
  options: RouteOptions<C, I, Params, Query, Body, R, Scoped>,
) => RouteDefinition;

export interface RouteApi<C extends RootContainer, I> {
  readonly get: RouteMethod<C, I>;
  readonly post: RouteMethod<C, I>;
  readonly put: RouteMethod<C, I>;
  readonly patch: RouteMethod<C, I>;
  readonly delete: RouteMethod<C, I>;
}

export interface ModuleDefinition {
  readonly name: string;
  readonly prefix: string;
  readonly routes: readonly RouteDefinition[];
  readonly security?: string;
  readonly authenticate?: (request: Request) => unknown | Promise<unknown>;
}

interface ModuleBase<C extends RootContainer, I> {
  readonly name: string;
  readonly prefix: string;
  readonly routes: (route: RouteApi<C, I>) => readonly RouteDefinition[];
}
export interface PublicModule<C extends RootContainer> extends ModuleBase<C, undefined> {
  readonly authenticate?: never;
  readonly security?: never;
}
export interface ProtectedModule<C extends RootContainer, I> extends ModuleBase<C, I> {
  readonly authenticate: (request: Request, root: C) => I | Promise<I>;
  readonly security?: string;
}
export interface ModuleBuilder<C extends RootContainer> {
  <I>(options: ProtectedModule<C, I>): ModuleDefinition;
  (options: PublicModule<C>): ModuleDefinition;
}

export interface OpenApiOptions {
  /** Exposes JSON at `${path}/json`; omitted means no HTTP documentation endpoint. */
  readonly path: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly securitySchemes?: Readonly<
    Record<
      string,
      { readonly type: string; readonly scheme?: string; readonly bearerFormat?: string }
    >
  >;
  /** Convert non-Valibot vendors into JSON Schema or reject them at startup. */
  readonly converters?: Readonly<Record<string, (schema: Schema) => object>>;
}
export interface ApplicationOptions<C extends RootContainer> {
  readonly container: C;
  readonly modules: (builders: {
    readonly module: ModuleBuilder<C>;
  }) => readonly ModuleDefinition[];
  readonly openapi?: OpenApiOptions;
}
export interface ListenOptions {
  readonly port: number;
  readonly hostname?: string;
  /** Optional application-owned outer fetch wrapper (e.g. logging); direct routing by default. */
  readonly fetch?: (request: Request) => Promise<Response> | Response;
}
export interface Listener {
  readonly url: URL;
  stop(): Promise<void>;
}
export interface Application {
  fetch(request: Request): Promise<Response>;
  listen(options: ListenOptions): Promise<Listener>;
  /** Stops admission and drains accepted handler work. Does not dispose the caller's root container. */
  close(): Promise<void>;
}
