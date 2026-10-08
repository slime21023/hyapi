// Adapter that points the spike's generated APIs at the real @hyapi/core implementation.
// `problem` and `createApp` are runtime (M2) APIs, so minimal stand-ins are declared here.
import type { Static } from "typebox";
import { Problem } from "../../../packages/core/contract.ts";

export { default as T } from "typebox";
export type { Static } from "typebox";
export {
  apiKey,
  defineApi,
  defineContract,
  defineResponse,
  defineSchema,
  defineSecurity,
  httpBearer,
  Problem,
} from "../../../packages/core/contract.ts";
export { type Handler, implement, notImplemented } from "../../../packages/core/mod.ts";

export function problem(value: Static<typeof Problem>): Static<typeof Problem> {
  return value;
}

export function createApp(options: {
  readonly api: unknown;
  readonly implementations: readonly unknown[];
  readonly verifiers: Readonly<Record<string, unknown>>;
}): Promise<{ fetch(request: Request): Promise<Response> }> {
  void options;
  return Promise.resolve({ fetch: () => Promise.resolve(new Response(null, { status: 501 })) });
}
