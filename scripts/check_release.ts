// Release checks, used by the publish workflow and by tests/release.
// Usage: deno run --allow-read scripts/check_release.ts [version]
import { join } from "jsr:@std/path@^1";

export interface ReleaseProblem {
  readonly file: string;
  readonly message: string;
}

/** Package manifests published to JSR (workspace members with a name). */
export async function publishedPackages(
  root: string,
): Promise<{ file: string; manifest: Record<string, unknown> }[]> {
  const workspace = JSON.parse(await Deno.readTextFile(join(root, "deno.json")))
    .workspace as string[];
  const packages = [];
  for (const member of workspace) {
    const file = join(root, member, "deno.json");
    const manifest = JSON.parse(await Deno.readTextFile(file));
    if (typeof manifest.name === "string") packages.push({ file, manifest });
  }
  return packages;
}

/**
 * Checks that every published package has the same version (equal to `expected` when given), a
 * license and exports, and that CHANGELOG.md has a section for that version.
 */
export async function checkRelease(root: string, expected?: string): Promise<ReleaseProblem[]> {
  const problems: ReleaseProblem[] = [];
  const packages = await publishedPackages(root);
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  const version = expected ?? (versions.size === 1 ? String([...versions][0]) : undefined);
  for (const { file, manifest } of packages) {
    if (version !== undefined && manifest.version !== version) {
      problems.push({ file, message: `version ${manifest.version} is not ${version}` });
    }
    if (manifest.license !== "MIT") problems.push({ file, message: "license must be MIT" });
    if (manifest.exports === undefined) problems.push({ file, message: "exports are missing" });
  }
  if (version === undefined) {
    problems.push({
      file: "deno.json",
      message: `packages disagree on the version: ${[...versions].join(", ")}`,
    });
  } else {
    const changelog = await Deno.readTextFile(join(root, "CHANGELOG.md"));
    if (!changelog.includes(`## [${version}]`)) {
      problems.push({ file: "CHANGELOG.md", message: `no "## [${version}]" section` });
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const problems = await checkRelease(root, Deno.args[0]);
  for (const problem of problems) console.error(`${problem.file}: ${problem.message}`);
  if (problems.length > 0) Deno.exit(1);
  console.log("release checks passed");
}
