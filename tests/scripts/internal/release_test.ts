import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReleaseTag, readPackages } from "../../../scripts/packages.ts";
import type { WorkspacePackage } from "../../../scripts/packages.ts";

function pkg(version: string): WorkspacePackage {
  return { directory: "packages/core", name: "hyapi", version };
}

test("only hyapi is selected for packing", async () => {
  const packages = await readPackages();
  assert.equal(packages.length, 1);
  assert.equal(packages[0]?.name, "hyapi");
  assertReleaseTag(`hyapi-v${packages[0]?.version}`, packages[0]!);
});

test("release tags accept matching stable versions from 0.5.0 onwards", () => {
  assert.doesNotThrow(() => assertReleaseTag("hyapi-v0.5.0", pkg("0.5.0")));
  assert.doesNotThrow(() => assertReleaseTag("hyapi-v1.0.0", pkg("1.0.0")));
});

test("release tags reject internal versions, prereleases, and old package names", () => {
  assert.throws(() => assertReleaseTag("hyapi-v0.4.9", pkg("0.4.9")), /internal/);
  assert.throws(() => assertReleaseTag("hyapi-v0.1.0", pkg("0.1.0")), /internal/);
  assert.throws(() => assertReleaseTag("hyapi-v0.5.0-rc.1", pkg("0.5.0-rc.1")), /stable/);
  assert.throws(() => assertReleaseTag("core-v0.5.0", pkg("0.5.0")), /stable/);
  assert.throws(() => assertReleaseTag("hyapi-v0.05.0", pkg("0.05.0")), /stable/);
  assert.throws(() => assertReleaseTag("hyapi-v0.5.1", pkg("0.5.0")), /does not match/);
});
