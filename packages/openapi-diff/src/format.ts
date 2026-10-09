import type { Change, DiffResult } from "./diff.ts";

/** Output formats for {@link formatDiff}. */
export type DiffFormat = "text" | "markdown" | "json";

function line(change: Change): string {
  const where = [change.operation, change.location].filter(Boolean).join(" · ");
  return `${where}: ${change.message} [${change.rule}]`;
}

/**
 * Formats a successful diff: `text` for terminals, `markdown` for pull request comments and
 * release notes, `json` for tools.
 */
export function formatDiff(result: Extract<DiffResult, { ok: true }>, format: DiffFormat): string {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  const breaking = result.changes.filter((c) => c.severity === "breaking");
  const other = result.changes.filter((c) => c.severity !== "breaking");
  const summary = `${breaking.length} breaking, ${other.length} non-breaking change(s)`;
  if (format === "text") {
    return [
      summary,
      ...breaking.map((c) => `BREAKING  ${line(c)}`),
      ...other.map((c) => `          ${line(c)}`),
    ].join("\n") + "\n";
  }
  const section = (title: string, changes: readonly Change[]) =>
    changes.length === 0 ? [] : [`### ${title}`, "", ...changes.map((c) => `- ${line(c)}`), ""];
  return [
    "## API changes",
    "",
    result.changes.length === 0 ? "No changes to the API contract." : `${summary}.`,
    "",
    ...section("Breaking changes", breaking),
    ...section("Other changes", other),
  ].join("\n").trimEnd() + "\n";
}
