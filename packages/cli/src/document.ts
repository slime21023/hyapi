import { stringify as stringifyYaml, type StringifyOptions } from "jsr:@std/yaml@^1.0.12";
import { type OpenApiDocument, serializeOpenApi } from "@hyapi/core/openapi";
import type { DocumentFormat } from "./config.ts";

/** Serializes the document in its canonical, deterministic text form. */
export function serialize(document: OpenApiDocument, format: DocumentFormat): string {
  if (format === "json") return serializeOpenApi(document);
  // Key order follows the document. No line folding and double quotes match `deno fmt`, so the
  // committed file is formatter-stable. `quoteStyle` is passed through to @std/yaml's dumper but
  // missing from its public type; the CLI tests check formatter stability on every upgrade.
  const options = { lineWidth: -1, quoteStyle: '"' } as StringifyOptions;
  return stringifyYaml(document as unknown as Record<string, unknown>, options);
}
