import assert from "node:assert/strict";
import { test } from "node:test";
import { overlappingPaths, routePattern } from "../../../packages/core/src/paths.ts";

test("route patterns match declared segments with an optional trailing slash", () => {
  const cases: [prefix: string, path: string, matches: string[], misses: string[]][] = [
    ["/users", "/:id", ["/users/a", "/users/a/"], ["/users", "/users/", "/users/a/b"]],
    ["/", "/", ["/"], ["/x"]],
    ["/", "/health", ["/health", "/health/"], ["/", "/healthz"]],
    ["/files", "/a.b", ["/files/a.b"], ["/files/axb"]],
    ["/x", "/a~b%20c", ["/x/a~b%20c"], ["/x/a~b c"]],
    ["/x", "/:_id/:a1", ["/x/1/2"], ["/x/1"]],
    ["/users", "/:id", [], ["/Users/a", "/USERS/a"]],
  ];
  for (const [prefix, path, matches, misses] of cases) {
    const pattern = routePattern(prefix, path);
    for (const candidate of matches)
      assert.ok(pattern.test(candidate), `${prefix}${path} should match ${candidate}`);
    for (const candidate of misses)
      assert.ok(!pattern.test(candidate), `${prefix}${path} should not match ${candidate}`);
  }
});

test("route patterns reject syntax the authentication matcher cannot mirror", () => {
  for (const path of ["/*", "/{id}", "/:1bad", "/a b", "/a?b"]) {
    assert.throws(() => routePattern("/x", path), /Unsupported route segment/, path);
  }
});

test("overlap detection treats parameters as wildcards and ignores case and trailing slashes", () => {
  const cases: [left: string, right: string, overlaps: boolean][] = [
    ["/a/b", "/a/b", true],
    ["/a/:id", "/a/me", true],
    ["/a/me", "/a/:id", true],
    ["/a/Items", "/a/items", true],
    ["/a/", "/a", true],
    ["/a/b", "/a/c", false],
    ["/a/:id", "/a/:id/c", false],
  ];
  for (const [left, right, overlaps] of cases) {
    assert.equal(overlappingPaths(left, right), overlaps, `${left} vs ${right}`);
  }
});
