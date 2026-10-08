/**
 * Compares two OpenAPI 3.1 documents and classifies every change as breaking or non-breaking for
 * consumers. It works on any OpenAPI 3.1 document and depends on no other package.
 *
 * ```ts
 * import { diffOpenApi, formatDiff } from "@hyapi/openapi-diff";
 *
 * const result = diffOpenApi(previous, current);
 * if (!result.ok) throw new Error(result.errors.join("\n"));
 * console.log(formatDiff(result, "markdown"));
 * if (result.breaking > 0) Deno.exit(1);
 * ```
 *
 * Rules are direction-aware. For what consumers send (parameters, request bodies), stricter is
 * breaking; for what they receive (responses), looser is breaking. Every change carries a stable
 * {@link RuleId}.
 *
 * @module
 */
export {
  type Change,
  diffOpenApi,
  type DiffResult,
  type RuleId,
  type Severity,
} from "./src/diff.ts";
export { type DiffFormat, formatDiff } from "./src/format.ts";
