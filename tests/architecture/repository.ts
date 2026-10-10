// What the architecture tests share: the repository root, how they read its sources, and how they
// resolve relative imports.

/** The repository root, without a trailing slash. */
export const ROOT: string = new URL("../..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1")
  .replace(/\/$/, "");

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) yield path;
  }
}

/** The TypeScript sources under `dir`, keyed by repository-relative path, in path order. */
export async function readSources(root: string, dir: string): Promise<Map<string, string>> {
  const sources: [string, string][] = [];
  for await (const file of sourceFiles(`${root}/${dir}`)) {
    sources.push([file.slice(root.length + 1), await Deno.readTextFile(file)]);
  }
  return new Map(sources.sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Resolves a relative specifier against the importing file's repository-relative path. */
export function resolveRelative(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}
