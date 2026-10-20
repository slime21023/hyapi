import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

export interface WorkspacePackage {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
}

export async function readPackages(): Promise<readonly WorkspacePackage[]> {
  const directory = join(root, "packages", "core");
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (manifest.name !== "hyapi" || typeof manifest.version !== "string") {
    throw new Error("Invalid hyapi package metadata.");
  }
  return [{ directory, name: manifest.name, version: manifest.version }];
}

export function assertReleaseTag(tag: string, pkg: WorkspacePackage): void {
  const match = /^hyapi-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) {
    throw new Error("Release tags must use hyapi-v<stable-version>.");
  }
  if (tag !== `hyapi-v${pkg.version}`) {
    throw new Error(`Release tag ${tag} does not match ${pkg.name}@${pkg.version}.`);
  }
  if (Number(match[1]) === 0 && Number(match[2]) < 5) {
    throw new Error("Versions before 0.5.0 are internal and cannot be published.");
  }
}

async function prepareLicense(pkg: WorkspacePackage): Promise<void> {
  for (const entry of ["mod.js", "mod.d.ts"]) {
    if (!(await stat(join(pkg.directory, "dist", entry))).isFile()) {
      throw new Error(`Build ${pkg.name} before packing.`);
    }
  }
  await copyFile(join(root, "LICENSE"), join(pkg.directory, "dist", "LICENSE"));
}

async function pack(pkg: WorkspacePackage, args: readonly string[]): Promise<void> {
  await runProcess("bun", ["pm", "pack", ...args], pkg.directory);
}

export async function packPackage(pkg: WorkspacePackage, destination: string): Promise<string> {
  await prepareLicense(pkg);
  await mkdir(destination, { recursive: true });
  const archive = resolve(destination, `hyapi-${pkg.version}.tgz`);
  await pack(pkg, ["--filename", archive]);
  return archive;
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== "--check") {
    throw new Error("Usage: bun scripts/packages.ts --check");
  }
  for (const pkg of await readPackages()) {
    await prepareLicense(pkg);
    console.log(`Checking ${pkg.name}@${pkg.version}`);
    await pack(pkg, ["--dry-run"]);
  }
}
