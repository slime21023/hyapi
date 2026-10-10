// Reading OpenAPI 3.1 documents: validation, `$ref` resolution, and operations keyed by method and
// path template.

/** A JSON object read without trusting its shape. */
export type Json = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** True for a non-null object that is not an array. */
export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when two values serialize to the same JSON. */
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Checks that a document is OpenAPI 3.1 with only internal references. */
export function validate(document: unknown, label: string): string[] {
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

/** Follows a node's `$ref`s within one document. */
export type Deref = (node: unknown) => unknown;

/** The value a JSON Pointer reference such as `#/components/schemas/Book` points to. */
function pointerTarget(document: Json, ref: string): unknown {
  let target: unknown = document;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    target = isObject(target) ? target[key] : undefined;
  }
  return target;
}

/** Follows `$ref`s from `node` until a value that is not a reference, stopping at cycles. */
function follow(document: Json, ids: ReadonlyMap<string, unknown>, node: unknown): unknown {
  const seen = new Set<string>();
  let current = node;
  while (isObject(current) && typeof current.$ref === "string" && !seen.has(current.$ref)) {
    const ref = current.$ref;
    seen.add(ref);
    if (ref.startsWith("#/")) {
      current = pointerTarget(document, ref);
      continue;
    }
    if (!ids.has(ref)) break;
    current = ids.get(ref);
  }
  return current;
}

/** Follows internal `$ref`s, including TypeBox's `$id`-based cyclic references. */
export function resolver(document: Json): Deref {
  const ids = new Map<string, unknown>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!isObject(node)) return;
    if (typeof node.$id === "string") ids.set(node.$id, node);
    Object.values(node).forEach(collect);
  };
  collect(document);
  return (node) => follow(document, ids, node);
}

/** One operation, with its parameters keyed by location and name. */
export interface Operation {
  readonly label: string;
  readonly node: Json;
  readonly parameters: Map<string, Json>;
}

/** An operation's parameters, path-level ones first, keyed by location and name. */
function parametersOf(shared: readonly unknown[], node: Json, deref: Deref): Map<string, Json> {
  const parameters = new Map<string, Json>();
  for (const raw of [...shared, ...(Array.isArray(node.parameters) ? node.parameters : [])]) {
    const parameter = deref(raw);
    if (!isObject(parameter)) continue;
    const name = String(parameter.name);
    const key = `${parameter.in}:${parameter.in === "header" ? name.toLowerCase() : name}`;
    parameters.set(key, parameter);
  }
  return parameters;
}

/** The operations of one path item, keyed by method and path template. */
function pathOperations(path: string, item: Json, deref: Deref): [string, Operation][] {
  const shared = Array.isArray(item.parameters) ? item.parameters : [];
  const operations: [string, Operation][] = [];
  for (const method of METHODS) {
    const node = deref(item[method]);
    if (!isObject(node)) continue;
    const key = `${method.toUpperCase()} ${path.replace(/\{[^}]*\}/g, "{}")}`;
    const parameters = parametersOf(shared, node, deref);
    operations.push([key, { label: `${method.toUpperCase()} ${path}`, node, parameters }]);
  }
  return operations;
}

/** Operations keyed by method and path template, so renamed path parameters still match. */
export function operationsOf(document: Json, deref: Deref): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  for (const [path, rawItem] of Object.entries(isObject(document.paths) ? document.paths : {})) {
    const item = deref(rawItem);
    if (!isObject(item)) continue;
    for (const [key, operation] of pathOperations(path, item, deref)) {
      operations.set(key, operation);
    }
  }
  return operations;
}

/** An operation's effective security requirements, normalized for comparison. */
export function securityOf(document: Json, operation: Json): string[] {
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
