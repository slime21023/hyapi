# Contributing to HyAPI

## Development workflow

Use Deno 2.9 or later. Before opening a pull request, run:

```text
deno task verify
```

During the redesign the command checks formatting and linting only. It grows with the new packages:
type checking, public contract tests, and contract checks are added as components are implemented.
Text files use LF line endings through `.gitattributes`, including on Windows checkouts.

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

The `v1.0.0-rc` candidates of the previous design were superseded before publication and will not be
tagged. Versioning restarts with the new design; release automation is re-established when the first
package is ready to publish.

Architecture decisions, the roadmap, and release gates are maintained in [`_adr/`](_adr/). Report
security issues privately as described in [SECURITY.md](SECURITY.md).
