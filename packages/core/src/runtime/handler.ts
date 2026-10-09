import type { AnyContract, Contract } from "../contract/define.ts";
import type { InputOf, ResultOf, SecurityOf } from "../contract/infer.ts";
import type { Schemes } from "../contract/security.ts";

type Awaitable<T> = T | Promise<T>;

/** Runtime information passed to every handler. */
export interface Context<Security = unknown> {
  /** Aborts on client disconnect, request timeout, or shutdown. */
  readonly signal: AbortSignal;
  /** The raw request. Its body has already been read when the operation declares one. */
  readonly request: Request;
  readonly operationId: string;
  /** The identities from the security requirement that succeeded; `undefined` when public. */
  readonly security: Security;
  /** The request ID, when `createApp({ requestId })` is on. */
  readonly requestId: string | undefined;
}

/** The handler type of one operation. */
export type HandlerFor<Op, S extends Schemes, Sec = undefined> = (
  input: InputOf<Op>,
  ctx: Context<SecurityOf<Op, S, Sec>>,
) => Awaitable<ResultOf<Op> | Response>;

/**
 * The type of the handler for `operationId` `K` of contract `C`, for handlers defined outside
 * {@link implement}.
 *
 * @example
 * ```ts
 * export const getUser: Handler<typeof users, "getUser"> = async ({ params }, ctx) => { ... };
 * ```
 */
export type Handler<C extends AnyContract, K extends keyof C["operations"]> = C extends
  Contract<infer S, infer Ops, infer Sec> ? HandlerFor<Ops[K & keyof Ops], S, Sec> : never;

/** Marks an operation that has no handler yet. It answers with a 501 problem response. */
export interface NotImplemented {
  readonly kind: "hyapi.not-implemented";
}

/** Stands in for the handler of an operation that is not implemented yet. */
export const notImplemented: NotImplemented = Object.freeze({ kind: "hyapi.not-implemented" });

/** The handlers bound to one contract. */
export interface Implementation<C extends AnyContract = AnyContract> {
  readonly kind: "hyapi.implementation";
  readonly contract: C;
  readonly handlers: Readonly<Record<string, unknown>>;
}

/**
 * Binds one handler, or {@link notImplemented}, to every operation of a contract. `createApp`
 * checks completeness again at startup.
 */
export function implement<S extends Schemes, Ops, Sec>(
  contract: Contract<S, Ops, Sec>,
  handlers: NoInfer<{ readonly [K in keyof Ops]: HandlerFor<Ops[K], S, Sec> | NotImplemented }>,
): Implementation<Contract<S, Ops, Sec>> {
  return Object.freeze({
    kind: "hyapi.implementation",
    contract,
    handlers: Object.freeze({ ...handlers }),
  });
}
