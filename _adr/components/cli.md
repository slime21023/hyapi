# Component: cli

- Package entry: `@hyapi/cli`
- Visibility: public. Commands, flags, exit codes, and output formats are the public contract.

## Purpose

Support the contract workflow outside the running service: create projects, emit the committed
OpenAPI document, govern its evolution, and diagnose contracts without starting a server.

## Responsibilities

- **`hyapi new <dir> [--local <repository>]`** creates a project with:
  - an example contract, handlers, and tests;
  - `fmt` settings and verification tasks; and
  - the committed OpenAPI document, produced by running the project's own `deno task emit`.

  `--local` maps `@hyapi/core` and the CLI to an unpublished checkout.
- **`hyapi emit`** loads the project's contract modules and runs `checkContracts`. It then writes
  the canonical document through [openapi](openapi.md). With `--check`, it fails when the committed
  document differs.
- **`hyapi diff`** compares the current document with a baseline through
  [openapi-diff](openapi-diff.md). It prints a pull-request summary and machine-readable results,
  and it fails on unacknowledged breaking changes.
- **`hyapi doctor`** runs contract diagnostics and checks that the committed document exists and is
  current, without starting a server. It also lists the framework statuses that operations can
  produce but do not declare.

## Boundary

- Uses only the public entries `@hyapi/core/contract` and `@hyapi/core/openapi`, plus
  `@hyapi/openapi-diff`. It never imports Core internals.
- Does not classify changes itself. Classification belongs to [openapi-diff](openapi-diff.md). The
  CLI resolves baselines, applies acknowledgements, and formats output for HyAPI projects.
- Does not check handlers or verifiers. Those checks run in `createApp` and tests.
- Does not generate types or handler code.

## Interface

Commands, flags, exit codes, and the output formats of `diff` and diagnostics.

## Dependencies

`@hyapi/core/contract`, `@hyapi/core/openapi`, `@hyapi/openapi-diff`, and Deno file system and
process APIs.

## Failure behavior

Each command exits non-zero on errors and prints every diagnostic together. `emit` never writes a
document from a contract that has errors.

## Related decisions

ADR 0001 §9, §10, §15, and the development workflow; ADR 0002 §1, §5.

## Resolved in M3

- **Configuration.** The `hyapi` section of `deno.json` names the API module and the document, for
  example `"hyapi": { "api": "./contracts/api.ts#api", "openapi": "./openapi.json" }`. `--api` and
  `--out` override it.
- **Formats.** The document is JSON or YAML, chosen by the file extension (`.json`, `.yaml`, or
  `.yml`). Both are deterministic and `deno fmt`-stable. `--check` ignores CRLF line endings.
- **Exit codes.** 0 for success, 1 for problems found (contract errors, or a stale or missing
  document), and 2 for usage errors.
- **Loading.** The CLI imports the API module dynamically. Contract recognition uses `kind` tags and
  string-keyed schema names, never object identity, so a second copy of `@hyapi/core` in the CLI's
  module graph is harmless.

## Open questions

- The `diff` baseline (a previous tag, a published URL, or the main branch) and the acknowledgement
  mechanism for breaking changes (M6).
- How the API changelog is produced at release time (M6).
