# Contributing to HyAPI

## Development workflow

Use Deno 2.9 or later. Before opening a pull request, run:

```text
deno task verify
```

The command checks formatting, linting, TypeScript types (core, CLI, example, benchmarks, and
scripts), the complete test suite, the example `doctor` report, and a generated starter project's
verification, listener response, and graceful shutdown. Text files use LF line endings through
`.gitattributes`, including on Windows checkouts.

## Changes and issues

Create a development issue before implementation. Use the **Development task** issue template and
record a goal, measurable key results, a `rule.yml` verification outline, and final test evidence.
Keep an issue focused on one independently reviewable behavior.

When work is complete, record the implementing commit, the relevant source or documentation path,
and the exact verification command result in the issue before closing it. A roadmap issue may be
closed only when its behavior is present on `main`, its documentation is current, and
`deno task verify` passes.

For a public API change, include documentation, example updates, and migration notes in the same
pull request. Do not expose Hono implementation details through a new HyAPI public API.

## Versioning and releases

HyAPI 1.x follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public API
consists of:

- every export of `packages/core/mod.ts` (`@hyapi/core`) and `packages/cli/mod.ts` (`@hyapi/cli`);
- CLI commands and flags;
- wire behavior: problem+json fields, the `x-request-id`, `x-hyapi-deadline`, and `x-hyapi-service`
  headers, and the values of `HttpContractClientError.reason` and `ResilienceError.reason`.

Breaking changes to the public API ship only in a major release. Minor releases add compatible
features; patch releases contain compatible fixes, documentation, and quality improvements.

After 1.0.0 is published, an API is removed only through deprecation: mark it with a `@deprecated`
JSDoc tag, record the deprecation in `CHANGELOG.md`, and keep it for at least one minor release
before removal in the next major.

Before 1.0.0, no superseded API is kept: the replacement lands in the same change that deletes the
old API, with no alias or transition period, and the change ships a migration note in
`docs/migrations/`.

Experimental APIs are marked with an `@experimental` JSDoc tag and may change in any minor release.

Before a release, the maintainer verifies the release gate in the relevant roadmap milestone,
updates `CHANGELOG.md`, runs `deno task verify` and `deno task publish:check` on a clean checkout,
and tags the resulting commit. Pushing a `v*` tag runs `.github/workflows/publish.yml`, which
rejects a tag that differs from either package version before repeating `deno task verify` and
publishing both packages to JSR.

The `v1.0.0-rc.2` freeze was reopened for lifecycle correctness fixes. `v1.0.0-rc.3` is the next
candidate, not a published release; its verification gate must pass before tagging. After that gate,
runtime and public API changes are out of scope before `v1.0.0`. A benchmark regression of more than
20% on the same hardware must be explained in the pull request; see
[docs/baselines/performance.md](docs/baselines/performance.md).

The roadmap and release gates are maintained in [docs/roadmap.md](docs/roadmap.md). Report security
issues privately as described in [SECURITY.md](SECURITY.md).
