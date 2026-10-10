import type { TObject, TSchema } from "typebox";

/** The full form of a declared response. */
export interface ResponseSpec {
  /** Documentation for the response. */
  readonly description: string;
  /** The body schema. Omit it for responses without a body, such as 204. */
  readonly body?: TSchema;
  /**
   * The body media type. Defaults to `application/json`, or `application/problem+json` when the
   * body is `Problem`.
   */
  readonly mediaType?: string;
  /** Response headers. Declared headers are required in handler results. */
  readonly headers?: TObject;
}

/**
 * A reusable response emitted under `#/components/responses`.
 *
 * @typeParam Spec - The response declaration, kept literal so that results are typed from it.
 */
export interface NamedResponse<Spec extends ResponseSpec = ResponseSpec> {
  readonly kind: "hyapi.response";
  readonly name: string;
  readonly spec: Spec;
}

/**
 * Declares a reusable response.
 *
 * @example
 * ```ts
 * export const NotFound = defineResponse("NotFound", {
 *   description: "The resource does not exist.",
 *   body: Problem,
 * });
 * ```
 */
export function defineResponse<const Spec extends ResponseSpec>(
  name: string,
  spec: Spec,
): NamedResponse<Spec> {
  return Object.freeze({ kind: "hyapi.response", name, spec });
}

/** Returns true when the value was created by {@link defineResponse}. */
export function isNamedResponse(value: unknown): value is NamedResponse {
  return typeof value === "object" && value !== null &&
    (value as { kind?: unknown }).kind === "hyapi.response";
}
