// What a classified change is, and how the comparison collects changes.

/** Whether a change can break existing consumers. */
export type Severity = "breaking" | "non-breaking";

/** Stable rule identifiers. Each is documented in the package README section of the module. */
export type RuleId =
  | "operation-removed"
  | "operation-added"
  | "operation-deprecated"
  | "operation-id-changed"
  | "security-added"
  | "security-removed"
  | "security-changed"
  | "parameter-removed"
  | "parameter-added"
  | "parameter-became-required"
  | "parameter-became-optional"
  | "request-body-added"
  | "request-body-removed"
  | "request-body-became-required"
  | "request-body-became-optional"
  | "media-type-removed"
  | "media-type-added"
  | "response-status-removed"
  | "response-status-added"
  | "response-header-removed"
  | "response-header-added"
  | "type-changed"
  | "enum-value-removed"
  | "enum-value-added"
  | "property-removed"
  | "property-added"
  | "property-became-required"
  | "property-became-optional"
  | "additional-properties-restricted"
  | "constraint-tightened"
  | "constraint-loosened"
  | "schema-changed";

/** One classified difference between two documents. */
export interface Change {
  readonly rule: RuleId;
  readonly severity: Severity;
  /** The affected operation as `METHOD /path`, when the change belongs to one. */
  readonly operation?: string;
  /** Where in the operation, for example `response 200 application/json · items[].title`. */
  readonly location: string;
  readonly message: string;
}

/** The result of `diffOpenApi`. Invalid input produces errors instead of a partial diff. */
export type DiffResult =
  | { readonly ok: true; readonly changes: readonly Change[]; readonly breaking: number }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Records one change of the operation that it is bound to. */
export type Add = (rule: RuleId, severity: Severity, location: string, message: string) => void;

/** Returns an `Add` that appends the changes of one operation, labelled `METHOD /path`. */
export function addTo(changes: Change[], operation: string): Add {
  return (rule, severity, location, message) =>
    changes.push({ rule, severity, operation, location, message });
}

/** `breaking` when the condition holds. */
export const breakingIf = (
  condition: boolean,
): Severity => (condition ? "breaking" : "non-breaking");

/** Whether a schema describes what consumers send or what they receive. */
export type Direction = "request" | "response";
