# Component: openapi-diff

- Package entry: `@hyapi/openapi-diff`
- Visibility: public. It is usable by any project, not only HyAPI projects.

## Purpose

Compare two OpenAPI documents and classify every change by its effect on consumers. This is the
engine behind HyAPI's evolution governance.

## Responsibilities

- Load two OpenAPI 3.1 documents as objects and resolve their internal references.
- Detect changes to operations, parameters, request bodies, responses, schemas, security
  requirements, and `deprecated` markers.
- Classify each change as **breaking** or **non-breaking** from the consumer's point of view, with a
  stable rule identifier. Examples of breaking changes:
  - a removed operation or response field;
  - a parameter or request field that is newly required;
  - a removed enum value; and
  - a narrowed type.
- Treat the direction of each change consistently. A request becoming stricter is breaking, and a
  response becoming looser is breaking.
- Return a structured result that callers can format as a summary, a changelog, or CI output.

## Boundary

- Depends on no HyAPI package and knows nothing about contracts.
- Does not read files, resolve git baselines, or decide whether a breaking change is acknowledged.
  Those belong to callers such as [cli](cli.md).
- Does not judge style or lint rules. It reports compatibility only.

## Interface

`diffOpenApi(base, head)` returns a list of classified changes. Each change has a rule identifier, a
severity (breaking or non-breaking), a location (operation, JSON Pointer), and a message.

## Dependencies

None, beyond standard Web APIs.

## Failure behavior

An invalid or unsupported input document is reported as an error result that names the problem. It
is never compared partially without saying so.

## Related decisions

ADR 0001 §10; ADR 0002 §1, §3, §4.

## Resolved in M6

- **Inputs.** OpenAPI 3.1 documents with internal references only. Another version, or an external
  `$ref`, is an error result (`{ ok: false, errors }`) that names the problem; nothing is compared
  partially. References are followed through `#/...` pointers and TypeBox-style `$id`s, with a guard
  for recursive schemas.
- **Interface.**
  - `diffOpenApi(base, head)` returns `{ ok: true, changes, breaking }`.
  - Each change has a stable `rule`, a `severity`, the `operation` (`METHOD /path`), a readable
    `location`, and a `message`.
  - Breaking changes come first.
  - `formatDiff(result, "text" | "markdown" | "json")` renders it.
- **Matching.** Operations are matched by method and path template, so renaming a path parameter is
  not a change. Header parameters are matched case-insensitively.
- **Rule set.** HyAPI defines its own small set of 32 rules (`RuleId`). The schema rules depend on
  direction: for what consumers send, stricter is breaking; for what they receive, looser is
  breaking.

  | Area                       | Rules                                                                                                                                                                                                   |
  | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Operations                 | `operation-removed` (breaking), `operation-added`, `operation-deprecated`, `operation-id-changed` (breaking, because generated client names change)                                                     |
  | Security                   | `security-added` (breaking), `security-removed`, `security-changed` (breaking)                                                                                                                          |
  | Parameters                 | `parameter-removed` (breaking), `parameter-added` (breaking if required), `parameter-became-required` (breaking), `parameter-became-optional`                                                           |
  | Request bodies             | `request-body-added` (breaking if required), `request-body-removed`, `request-body-became-required` (breaking), `request-body-became-optional`                                                          |
  | Media types                | `media-type-removed` (breaking), `media-type-added`                                                                                                                                                     |
  | Responses                  | `response-status-removed` (breaking for 2xx), `response-status-added`, `response-header-removed` (breaking if required), `response-header-added`                                                        |
  | Schemas                    | `type-changed` (requests may widen, responses may narrow), `enum-value-removed`, and `enum-value-added` (TypeBox literal unions count as enums)                                                         |
  | Object properties          | `property-removed`, `property-added`, `property-became-required`, `property-became-optional`, `additional-properties-restricted`                                                                        |
  | Constraints and composites | `constraint-tightened` (breaking for requests), `constraint-loosened` (never breaking), and `schema-changed` (a changed `anyOf`/`oneOf`/`allOf` that cannot be classified; breaking, for manual review) |

  The rules cover the same ground as oasdiff's common checks, but the identifiers are HyAPI's own.

## Open questions

- Accepting OpenAPI 3.0 or 3.2, and bundling external references, for projects other than HyAPI.
