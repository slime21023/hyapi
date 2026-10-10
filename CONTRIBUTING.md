# Contributing to HyAPI

## Development workflow

Use Deno 2.9 or later. Before opening a pull request, run:

```text
deno task verify
```

The command checks formatting, linting, and types, and runs every test under `tests/`. The tests
include the architecture tests (`tests/architecture/`), which enforce the dependency rules of
[ADR 0002](_adr/0002-architecture-and-component-boundaries.md), the layer rules of
[ADR 0003](_adr/0003-layered-architecture.md), the contract boundaries of
[ADR 0004](_adr/0004-contract-structure-and-base.md), an acyclic import graph, and the naming and
nesting rules of `AGENTS.md`. A public API snapshot test compares every entry point's symbols with
`tests/architecture/public_api.snapshot.txt`; after a deliberate public API change, run
`deno task api:update` and commit the updated snapshot. CI runs the same command on every push to
`main` and on every pull request. Text files use LF line endings through `.gitattributes`, including
on Windows checkouts.

CI also runs `hyapi diff` for the example application against `main`. A pull request that changes
the example's API in a breaking way on purpose acknowledges it with the `breaking-api` label.

## Changes and issues

Create a development issue before implementation. Use the **Development task** issue template and
record a goal, measurable key results, a `rule.yml` verification outline, and final test evidence.
Keep an issue focused on one independently reviewable behavior.

When work is complete, record the implementing commit, the relevant source or documentation path,
and the exact verification command result in the issue before closing it. An issue may be closed
only when its behavior is present on `main`, its documentation is current, and `deno task verify`
passes.

For a public API change, update the affected component specification in `_adr/components/`, and
include documentation and example updates in the same pull request.

## Versioning and releases

HyAPI follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public API consists of
the public entry points defined in [ADR 0002](_adr/0002-architecture-and-component-boundaries.md),
the CLI commands, flags, and output formats, and the wire behavior of problem responses. Before
1.0.0, no superseded API is kept: the replacement lands in the same change that deletes the old API,
and a design-changing decision is recorded in `_adr/`.

The previous design reached `1.0.0-rc.4`, which was published to JSR, and was then superseded. The
new design restarts at `0.x`: `0.1.0` was not published, and `0.2.0` is its first release. Because
`1.0.0-rc.4` is a pre-release, JSR resolves an unversioned `@hyapi/*` import to the newest `0.x`
release. Before 1.0.0, minor versions may change the public API; the changelog lists every change.

### Releasing

All published packages share one version.

1. Set the same `version` in every published package's `deno.json`, and add a
   `## [<version>] - <date>` section to `CHANGELOG.md`.
2. Run `deno task verify` and `deno task publish:check` on a clean checkout. The test
   `tests/release/` also checks that the versions and the changelog agree.
3. Tag the commit `v<version>` and push the tag. `.github/workflows/publish.yml` runs
   `scripts/check_release.ts` against the tag, repeats `deno task verify`, and publishes every
   package to JSR. JSR authenticates the workflow through OIDC, so no token is stored.

A request-path benchmark regression of more than 20% on the same hardware must be explained in the
pull request; see [`_adr/baselines/request-path.md`](_adr/baselines/request-path.md).

Architecture decisions, the roadmap, and release gates are maintained in [`_adr/`](_adr/). Report
security issues privately as described in [SECURITY.md](SECURITY.md).
