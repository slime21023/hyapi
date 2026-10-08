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

## Open questions

- Whether OpenAPI 3.0 and 3.2 inputs are accepted, since the package serves projects other than
  HyAPI.
- The initial rule set, and how it relates to existing tools such as oasdiff.
- Whether external `$ref`s are supported, or documents must be bundled first.
