// Type-level checks that a path template and its `params` schema name the same parameters, so the
// editor reports a mismatch where the operation is declared.
import type { TObject } from "typebox";

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

export type CheckedOperations<Operations> = {
  readonly [OperationId in keyof Operations]: CheckOperation<Operations[OperationId]>;
};
