import type { AnyContract, Contract } from "../contract/declare/contract.ts";
import type { Schemes } from "../contract/declare/security.ts";
import type { InputOf, ResultOf, SecurityOf } from "../contract/infer.ts";

/**
 * Runtime information passed to every handler.
 *
 * @typeParam Identities - The identities of the security requirement that succeeded, by scheme
 *   name; inferred from the contract.
 */
export interface Context<Identities = unknown> {
  /** Aborts on client disconnect, request timeout, or shutdown. */
  readonly signal: AbortSignal;
  /** The raw request. Its body has already been read when the operation declares one. */
  readonly request: Request;
  readonly operationId: string;
  /** The identities from the security requirement that succeeded; `undefined` when public. */
  readonly security: Identities;
  /** The request ID, when `createApp({ requestId })` is on. */
  readonly requestId: string | undefined;
}

/** The handler type of one operation, from its declaration and its contract's security. */
type HandlerFor<Operation, SchemeSet extends Schemes, DefaultSecurity> = (
  input: InputOf<Operation>,
  ctx: Context<SecurityOf<Operation, SchemeSet, DefaultSecurity>>,
) => ResultOf<Operation> | Response | Promise<ResultOf<Operation> | Response>;

/**
 * The type of one operation's handler, for handlers defined outside {@link implement}.
 *
 * @typeParam Resource - The contract, as `typeof contract`.
 * @typeParam OperationId - The operation's `operationId`.
 *
 * @example
 * ```ts
 * export const getUser: Handler<typeof users, "getUser"> = async ({ params }, ctx) => { ... };
 * ```
 */
export type Handler<
  Resource extends AnyContract,
  OperationId extends keyof Resource["operations"],
> = Resource extends Contract<infer SchemeSet, infer Operations, infer DefaultSecurity>
  ? HandlerFor<Operations[OperationId & keyof Operations], SchemeSet, DefaultSecurity>
  : never;

/** Marks an operation that has no handler yet. It answers with a 501 problem response. */
interface NotImplemented {
  readonly kind: "hyapi.not-implemented";
}

/** Stands in for the handler of an operation that is not implemented yet. */
export const notImplemented: NotImplemented = Object.freeze({ kind: "hyapi.not-implemented" });

/** The handlers bound to one contract. */
export interface Implementation {
  readonly kind: "hyapi.implementation";
  readonly contract: AnyContract;
  readonly handlers: Readonly<Record<string, unknown>>;
}

/**
 * Binds one handler, or {@link notImplemented}, to every operation of a contract. `createApp`
 * checks completeness again at startup.
 */
export function implement<SchemeSet extends Schemes, Operations, DefaultSecurity>(
  contract: Contract<SchemeSet, Operations, DefaultSecurity>,
  // `NoInfer` keeps the contract, not the handlers, as the source of every type.
  handlers: NoInfer<
    {
      readonly [OperationId in keyof Operations]:
        | HandlerFor<Operations[OperationId], SchemeSet, DefaultSecurity>
        | NotImplemented;
    }
  >,
): Implementation {
  return Object.freeze({
    kind: "hyapi.implementation",
    contract,
    handlers: Object.freeze({ ...handlers }),
  });
}
