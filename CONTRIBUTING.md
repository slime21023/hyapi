# Contributing to HyAPI

## Development workflow

Use Deno 2.9 or later. Before opening a pull request, run:

```text
deno task verify
```

The command checks formatting, linting, TypeScript types, and the complete test suite. Text files
use LF line endings through `.gitattributes`, including on Windows checkouts.

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

HyAPI follows semantic versioning with the following pre-1.0 policy:

- Patch releases (`0.1.x`) contain compatible fixes, documentation, and quality improvements.
- Minor releases (`0.2.0`, `0.3.0`, and later) may change public APIs only when their milestone
  explicitly declares the breaking change and provides a migration guide.
- Experimental APIs must be marked as such in their documentation and may change in the next minor
  release.

Before a release, the maintainer verifies the release gate in the relevant roadmap milestone,
updates `CHANGELOG.md`, runs `deno task verify` on a clean checkout, and tags the resulting commit.

During the `v1.0.0-rc.1` freeze, runtime and public API changes are out of scope. Only test
coverage, repeatable performance or security regression evidence, and documentation/example fixes
may be merged before the final `v1.0.0` tag.

The roadmap and release gates are maintained in [docs/roadmap.md](docs/roadmap.md).
