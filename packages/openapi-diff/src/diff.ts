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

/** The result of {@link diffOpenApi}. Invalid input produces errors instead of a partial diff. */
export type DiffResult =
  | { readonly ok: true; readonly changes: readonly Change[]; readonly breaking: number }
  | { readonly ok: false; readonly errors: readonly string[] };

type Json = Record<string, unknown>;
type Direction = "request" | "response";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const UPPER_BOUNDS = ["maxLength", "maxItems", "maximum", "exclusiveMaximum", "maxProperties"];
const LOWER_BOUNDS = ["minLength", "minItems", "minimum", "exclusiveMinimum", "minProperties"];
const EXACT_CONSTRAINTS = ["pattern", "format", "multipleOf", "uniqueItems"];

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Checks that a document is OpenAPI 3.1 with only internal references. */
function validate(document: unknown, label: string): string[] {
  if (!isObject(document)) return [`the ${label} document is not an object`];
  const errors: string[] = [];
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.1.")) {
    errors.push(
      `the ${label} document is OpenAPI ${String(document.openapi)}; only 3.1 is supported`,
    );
  }
  if (document.paths !== undefined && !isObject(document.paths)) {
    errors.push(`the ${label} document has an invalid 'paths' object`);
  }
  const visit = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) return node.forEach((item, i) => visit(item, `${pointer}/${i}`));
    if (!isObject(node)) return;
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
      errors.push(
        `the ${label} document has an external $ref '${node.$ref}' at ${pointer || "/"}; ` +
          "bundle the document first",
      );
    }
    for (const [key, value] of Object.entries(node)) visit(value, `${pointer}/${key}`);
  };
  visit(document, "");
  return errors;
}

/** Follows internal `$ref`s, including TypeBox's `$id`-based cyclic references. */
function resolver(document: Json) {
  const ids = new Map<string, unknown>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!isObject(node)) return;
    if (typeof node.$id === "string") ids.set(node.$id, node);
    Object.values(node).forEach(collect);
  };
  collect(document);
  return (node: unknown): unknown => {
    const seen = new Set<string>();
    let current = node;
    while (isObject(current) && typeof current.$ref === "string" && !seen.has(current.$ref)) {
      const ref = current.$ref;
      seen.add(ref);
      if (ref.startsWith("#/")) {
        let target: unknown = document;
        for (const raw of ref.slice(2).split("/")) {
          const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
          target = isObject(target) ? target[key] : undefined;
        }
        current = target;
      } else if (ids.has(ref)) current = ids.get(ref);
      else break;
    }
    return current;
  };
}

interface Operation {
  readonly label: string;
  readonly node: Json;
  readonly parameters: Map<string, Json>;
}

function operationsOf(document: Json, deref: (node: unknown) => unknown): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  for (const [path, rawItem] of Object.entries(isObject(document.paths) ? document.paths : {})) {
    const item = deref(rawItem);
    if (!isObject(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const node = deref(item[method]);
      if (!isObject(node)) continue;
      const parameters = new Map<string, Json>();
      for (const raw of [...shared, ...(Array.isArray(node.parameters) ? node.parameters : [])]) {
        const parameter = deref(raw);
        if (!isObject(parameter)) continue;
        const name = String(parameter.name);
        const key = `${parameter.in}:${parameter.in === "header" ? name.toLowerCase() : name}`;
        parameters.set(key, parameter);
      }
      const key = `${method.toUpperCase()} ${path.replace(/\{[^}]*\}/g, "{}")}`;
      operations.set(key, { label: `${method.toUpperCase()} ${path}`, node, parameters });
    }
  }
  return operations;
}

function enumValues(schema: Json): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  if ("const" in schema && schema.anyOf === undefined) return [schema.const];
  const members = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
    ? schema.oneOf
    : undefined;
  if (
    members !== undefined && members.length > 0 && members.every((m) => isObject(m) && "const" in m)
  ) {
    return members.map((m) => (m as Json).const);
  }
  return undefined;
}

function typeSet(schema: Json): Set<string> | undefined {
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type.map(String));
  return undefined;
}

/** True when every value of type set `a` is also allowed by `b` (integer ⊂ number). */
function within(a: Set<string>, b: Set<string>): boolean {
  return [...a].every((type) => b.has(type) || (type === "integer" && b.has("number")));
}

function securityOf(document: Json, operation: Json): string[] {
  const requirements = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(document.security)
    ? document.security
    : [];
  return requirements.map((requirement) =>
    Object.entries(isObject(requirement) ? requirement : {})
      .map(([scheme, scopes]) =>
        `${scheme}(${Array.isArray(scopes) ? [...scopes].sort().join(",") : ""})`
      )
      .sort()
      .join("+")
  ).sort();
}

/**
 * Compares two OpenAPI 3.1 documents and classifies every change by its effect on consumers.
 *
 * Changes are direction-aware. For what consumers send (parameters, request bodies), a stricter
 * contract is breaking. For what they receive (responses), a looser contract is breaking.
 * Operations are matched by method and path template, so renaming a path parameter is not a
 * change.
 */
export function diffOpenApi(base: unknown, head: unknown): DiffResult {
  const errors = [...validate(base, "base"), ...validate(head, "head")];
  if (errors.length > 0) return { ok: false, errors };
  const baseDoc = base as Json;
  const headDoc = head as Json;
  const derefBase = resolver(baseDoc);
  const derefHead = resolver(headDoc);
  const changes: Change[] = [];

  let operation: string | undefined;
  const add = (rule: RuleId, severity: Severity, location: string, message: string) =>
    changes.push({
      rule,
      severity,
      ...(operation === undefined ? {} : { operation }),
      location,
      message,
    });
  const breakingIf = (condition: boolean): Severity => (condition ? "breaking" : "non-breaking");

  function compareSchema(
    rawBase: unknown,
    rawHead: unknown,
    direction: Direction,
    location: string,
    seen: Set<string>,
  ) {
    const b = derefBase(rawBase);
    const h = derefHead(rawHead);
    if (!isObject(b) || !isObject(h)) return;
    // Identical text is unchanged only without references: the same `$ref` can point to
    // definitions that differ between the two documents.
    const text = JSON.stringify(b);
    if (text === JSON.stringify(h) && !text.includes('"$ref"')) return;
    const pair = `${JSON.stringify(rawBase)}|${JSON.stringify(rawHead)}|${direction}`;
    if (seen.has(pair)) return;
    seen.add(pair);
    const request = direction === "request";

    const baseEnum = enumValues(b);
    const headEnum = enumValues(h);
    if (baseEnum !== undefined && headEnum !== undefined) {
      for (const value of baseEnum.filter((v) => !headEnum.some((w) => same(v, w)))) {
        add(
          "enum-value-removed",
          breakingIf(request),
          location,
          `enum value ${JSON.stringify(value)} was removed`,
        );
      }
      for (const value of headEnum.filter((v) => !baseEnum.some((w) => same(v, w)))) {
        add(
          "enum-value-added",
          breakingIf(!request),
          location,
          `enum value ${JSON.stringify(value)} was added`,
        );
      }
      return;
    }
    const composite = (s: Json) => ["anyOf", "oneOf", "allOf", "not", "if"].some((k) => k in s);
    if (composite(b) || composite(h)) {
      add(
        "schema-changed",
        "breaking",
        location,
        "a composite schema changed and cannot be classified; review it",
      );
      return;
    }

    const baseTypes = typeSet(b);
    const headTypes = typeSet(h);
    if (baseTypes && headTypes && !same([...baseTypes].sort(), [...headTypes].sort())) {
      const widened = within(baseTypes, headTypes);
      const narrowed = within(headTypes, baseTypes);
      const describe = `type ${[...baseTypes].join("|")} became ${[...headTypes].join("|")}`;
      // Requests may widen; responses may narrow. Anything else can break consumers.
      add("type-changed", breakingIf(request ? !widened : !narrowed), location, describe);
      if (!widened && !narrowed) return;
    }

    const tightened: string[] = [];
    const loosened: string[] = [];
    for (const key of UPPER_BOUNDS) {
      const [bv, hv] = [b[key], h[key]];
      if (bv === hv) continue;
      if (typeof hv === "number" && (typeof bv !== "number" || hv < bv)) tightened.push(key);
      else loosened.push(key);
    }
    for (const key of LOWER_BOUNDS) {
      const [bv, hv] = [b[key], h[key]];
      if (bv === hv) continue;
      if (typeof hv === "number" && (typeof bv !== "number" || hv > bv)) tightened.push(key);
      else loosened.push(key);
    }
    for (const key of EXACT_CONSTRAINTS) {
      if (same(b[key], h[key])) continue;
      if (h[key] === undefined || h[key] === false) loosened.push(key);
      else tightened.push(key);
    }
    if (tightened.length > 0) {
      add(
        "constraint-tightened",
        breakingIf(request),
        location,
        `tightened: ${tightened.join(", ")}`,
      );
    }
    if (loosened.length > 0) {
      add("constraint-loosened", "non-breaking", location, `loosened: ${loosened.join(", ")}`);
    }

    if (isObject(b.properties) || isObject(h.properties)) {
      const bp = isObject(b.properties) ? b.properties : {};
      const hp = isObject(h.properties) ? h.properties : {};
      const breq = new Set(Array.isArray(b.required) ? b.required.map(String) : []);
      const hreq = new Set(Array.isArray(h.required) ? h.required.map(String) : []);
      const at = (
        name: string,
      ) => (location.endsWith("·") ? `${location} ${name}` : `${location}.${name}`);
      for (const name of Object.keys(bp)) {
        if (name in hp) continue;
        const closed = h.additionalProperties === false;
        add(
          "property-removed",
          breakingIf(!request || closed),
          at(name),
          request && !closed
            ? "the property was removed; servers that allow extra properties ignore it"
            : "the property was removed",
        );
      }
      for (const name of Object.keys(hp)) {
        if (name in bp) continue;
        const required = hreq.has(name);
        add(
          "property-added",
          breakingIf(request && required),
          at(name),
          required ? "a required property was added" : "an optional property was added",
        );
      }
      for (const name of Object.keys(bp)) {
        if (!(name in hp)) continue;
        if (!breq.has(name) && hreq.has(name)) {
          add(
            "property-became-required",
            breakingIf(request),
            at(name),
            "the property became required",
          );
        } else if (breq.has(name) && !hreq.has(name)) {
          add(
            "property-became-optional",
            breakingIf(!request),
            at(name),
            "the property became optional",
          );
        }
        compareSchema(bp[name], hp[name], direction, at(name), seen);
      }
    }
    if (request && b.additionalProperties !== false && h.additionalProperties === false) {
      add(
        "additional-properties-restricted",
        "breaking",
        location,
        "additional properties are no longer allowed",
      );
    }
    if (b.items !== undefined || h.items !== undefined) {
      compareSchema(
        b.items,
        h.items,
        direction,
        location.endsWith("·") ? `${location} []` : `${location}[]`,
        seen,
      );
    }
  }

  function compareContent(
    baseContent: unknown,
    headContent: unknown,
    direction: Direction,
    location: string,
  ) {
    const bc = isObject(baseContent) ? baseContent : {};
    const hc = isObject(headContent) ? headContent : {};
    for (const type of Object.keys(bc)) {
      if (!(type in hc)) {
        add(
          "media-type-removed",
          "breaking",
          `${location} ${type}`,
          `media type ${type} was removed`,
        );
      }
    }
    for (const type of Object.keys(hc)) {
      if (!(type in bc)) {
        add(
          "media-type-added",
          "non-breaking",
          `${location} ${type}`,
          `media type ${type} was added`,
        );
      } else {
        compareSchema(
          (bc[type] as Json)?.schema,
          (hc[type] as Json)?.schema,
          direction,
          `${location} ${type} ·`,
          new Set(),
        );
      }
    }
  }

  const baseOps = operationsOf(baseDoc, derefBase);
  const headOps = operationsOf(headDoc, derefHead);
  for (const [key, b] of baseOps) {
    if (headOps.has(key)) continue;
    operation = b.label;
    add("operation-removed", "breaking", "operation", "the operation was removed");
  }
  for (const [key, h] of headOps) {
    const b = baseOps.get(key);
    operation = h.label;
    if (b === undefined) {
      add("operation-added", "non-breaking", "operation", "the operation was added");
      continue;
    }
    if (b.node.deprecated !== true && h.node.deprecated === true) {
      add("operation-deprecated", "non-breaking", "operation", "the operation was deprecated");
    }
    if (b.node.operationId !== h.node.operationId) {
      add(
        "operation-id-changed",
        "breaking",
        "operationId",
        `operationId '${String(b.node.operationId)}' became '${
          String(h.node.operationId)
        }'; generated client method names change`,
      );
    }

    const baseSecurity = securityOf(baseDoc, b.node);
    const headSecurity = securityOf(headDoc, h.node);
    if (!same(baseSecurity, headSecurity)) {
      if (baseSecurity.length === 0) {
        add("security-added", "breaking", "security", "the operation now requires authentication");
      } else if (headSecurity.length === 0) {
        add(
          "security-removed",
          "non-breaking",
          "security",
          "the operation no longer requires authentication",
        );
      } else {
        add(
          "security-changed",
          "breaking",
          "security",
          `security changed from [${baseSecurity.join(" | ")}] to [${headSecurity.join(" | ")}]`,
        );
      }
    }

    for (const [key2, parameter] of b.parameters) {
      const location = `${parameter.in} parameter ${parameter.name}`;
      const next = h.parameters.get(key2);
      if (next === undefined) {
        add("parameter-removed", "breaking", location, "the parameter was removed");
        continue;
      }
      if (parameter.required !== true && next.required === true) {
        add("parameter-became-required", "breaking", location, "the parameter became required");
      } else if (parameter.required === true && next.required !== true) {
        add("parameter-became-optional", "non-breaking", location, "the parameter became optional");
      }
      compareSchema(parameter.schema, next.schema, "request", location, new Set());
    }
    for (const [key2, parameter] of h.parameters) {
      if (b.parameters.has(key2)) continue;
      const required = parameter.required === true;
      add(
        "parameter-added",
        breakingIf(required),
        `${parameter.in} parameter ${parameter.name}`,
        required ? "a required parameter was added" : "an optional parameter was added",
      );
    }

    const baseBody = derefBase(b.node.requestBody);
    const headBody = derefHead(h.node.requestBody);
    if (!isObject(baseBody) && isObject(headBody)) {
      const required = headBody.required === true;
      add(
        "request-body-added",
        breakingIf(required),
        "request body",
        required ? "a required request body was added" : "an optional request body was added",
      );
    } else if (isObject(baseBody) && !isObject(headBody)) {
      add("request-body-removed", "non-breaking", "request body", "the request body was removed");
    } else if (isObject(baseBody) && isObject(headBody)) {
      if (baseBody.required !== true && headBody.required === true) {
        add(
          "request-body-became-required",
          "breaking",
          "request body",
          "the request body became required",
        );
      } else if (baseBody.required === true && headBody.required !== true) {
        add(
          "request-body-became-optional",
          "non-breaking",
          "request body",
          "the request body became optional",
        );
      }
      compareContent(baseBody.content, headBody.content, "request", "request body");
    }

    const baseResponses = isObject(b.node.responses) ? b.node.responses : {};
    const headResponses = isObject(h.node.responses) ? h.node.responses : {};
    for (const status of Object.keys(baseResponses)) {
      if (status in headResponses) continue;
      add(
        "response-status-removed",
        breakingIf(status.startsWith("2")),
        `response ${status}`,
        `response ${status} was removed`,
      );
    }
    for (const status of Object.keys(headResponses)) {
      const br = derefBase(baseResponses[status]);
      const hr = derefHead(headResponses[status]);
      if (!(status in baseResponses)) {
        add(
          "response-status-added",
          "non-breaking",
          `response ${status}`,
          `response ${status} was added`,
        );
        continue;
      }
      if (!isObject(br) || !isObject(hr)) continue;
      const bh = isObject(br.headers) ? br.headers : {};
      const hh = isObject(hr.headers) ? hr.headers : {};
      const lower = (o: Json) =>
        new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), derefHead(v)]));
      const headHeaders = lower(hh);
      for (const [name, header] of Object.entries(bh)) {
        if (!headHeaders.has(name.toLowerCase())) {
          const required = isObject(derefBase(header)) &&
            (derefBase(header) as Json).required === true;
          add(
            "response-header-removed",
            breakingIf(required),
            `response ${status} header ${name}`,
            "the response header was removed",
          );
        }
      }
      const baseHeaders = new Set(Object.keys(bh).map((k) => k.toLowerCase()));
      for (const name of Object.keys(hh)) {
        if (!baseHeaders.has(name.toLowerCase())) {
          add(
            "response-header-added",
            "non-breaking",
            `response ${status} header ${name}`,
            "a response header was added",
          );
        }
      }
      compareContent(br.content, hr.content, "response", `response ${status}`);
    }
  }

  changes.sort((a, z) =>
    (a.severity === z.severity ? 0 : a.severity === "breaking" ? -1 : 1) ||
    (a.operation ?? "").localeCompare(z.operation ?? "") ||
    a.location.localeCompare(z.location)
  );
  return { ok: true, changes, breaking: changes.filter((c) => c.severity === "breaking").length };
}
