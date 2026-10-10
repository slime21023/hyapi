// Comparing operations: deprecation, `operationId`, security, parameters, request bodies,
// responses, response headers, and media types.
import { addTo, breakingIf, type Change, type Direction } from "./change.ts";
import {
  isObject,
  type Json,
  type Operation,
  operationsOf,
  resolver,
  same,
  securityOf,
} from "./document.ts";
import { compareSchema, type SchemaComparison } from "./schema.ts";

/** What the comparison of one operation reads and reports to. */
interface OperationComparison extends SchemaComparison {
  readonly baseDocument: Json;
  readonly headDocument: Json;
}

/** Compares the operations of two documents and appends their classified changes. */
export function compareOperations(baseDocument: Json, headDocument: Json, changes: Change[]): void {
  const base = resolver(baseDocument);
  const head = resolver(headDocument);
  const baseOps = operationsOf(baseDocument, base);
  const headOps = operationsOf(headDocument, head);
  for (const [key, b] of baseOps) {
    if (headOps.has(key)) continue;
    addTo(changes, b.label)(
      "operation-removed",
      "breaking",
      "operation",
      "the operation was removed",
    );
  }
  for (const [key, h] of headOps) {
    const add = addTo(changes, h.label);
    const b = baseOps.get(key);
    if (b === undefined) {
      add("operation-added", "non-breaking", "operation", "the operation was added");
      continue;
    }
    compareOperation({ base, head, add, baseDocument, headDocument }, b, h);
  }
}

function compareOperation(ctx: OperationComparison, b: Operation, h: Operation): void {
  if (b.node.deprecated !== true && h.node.deprecated === true) {
    ctx.add(
      "operation-deprecated",
      "non-breaking",
      "operation",
      "the operation was deprecated",
    );
  }
  if (b.node.operationId !== h.node.operationId) {
    ctx.add(
      "operation-id-changed",
      "breaking",
      "operationId",
      `operationId '${String(b.node.operationId)}' became '${
        String(h.node.operationId)
      }'; generated client method names change`,
    );
  }
  compareSecurity(ctx, b, h);
  compareParameters(ctx, b, h);
  compareRequestBody(ctx, b, h);
  compareResponses(ctx, b, h);
}

function compareSecurity(ctx: OperationComparison, b: Operation, h: Operation): void {
  const baseSecurity = securityOf(ctx.baseDocument, b.node);
  const headSecurity = securityOf(ctx.headDocument, h.node);
  if (same(baseSecurity, headSecurity)) return;
  if (baseSecurity.length === 0) {
    ctx.add(
      "security-added",
      "breaking",
      "security",
      "the operation now requires authentication",
    );
  } else if (headSecurity.length === 0) {
    ctx.add(
      "security-removed",
      "non-breaking",
      "security",
      "the operation no longer requires authentication",
    );
  } else {
    ctx.add(
      "security-changed",
      "breaking",
      "security",
      `security changed from [${baseSecurity.join(" | ")}] to [${headSecurity.join(" | ")}]`,
    );
  }
}

function compareParameters(ctx: OperationComparison, b: Operation, h: Operation): void {
  for (const [key, parameter] of b.parameters) {
    const location = `${parameter.in} parameter ${parameter.name}`;
    const next = h.parameters.get(key);
    if (next === undefined) {
      ctx.add("parameter-removed", "breaking", location, "the parameter was removed");
      continue;
    }
    if (parameter.required !== true && next.required === true) {
      ctx.add(
        "parameter-became-required",
        "breaking",
        location,
        "the parameter became required",
      );
    } else if (parameter.required === true && next.required !== true) {
      ctx.add(
        "parameter-became-optional",
        "non-breaking",
        location,
        "the parameter became optional",
      );
    }
    compareSchema(ctx, parameter.schema, next.schema, "request", location, new Set());
  }
  for (const [key, parameter] of h.parameters) {
    if (b.parameters.has(key)) continue;
    const required = parameter.required === true;
    ctx.add(
      "parameter-added",
      breakingIf(required),
      `${parameter.in} parameter ${parameter.name}`,
      required ? "a required parameter was added" : "an optional parameter was added",
    );
  }
}

function compareRequestBody(ctx: OperationComparison, b: Operation, h: Operation): void {
  const baseBody = ctx.base(b.node.requestBody);
  const headBody = ctx.head(h.node.requestBody);
  if (!isObject(baseBody) && isObject(headBody)) {
    const required = headBody.required === true;
    ctx.add(
      "request-body-added",
      breakingIf(required),
      "request body",
      required ? "a required request body was added" : "an optional request body was added",
    );
    return;
  }
  if (isObject(baseBody) && !isObject(headBody)) {
    ctx.add(
      "request-body-removed",
      "non-breaking",
      "request body",
      "the request body was removed",
    );
    return;
  }
  if (!isObject(baseBody) || !isObject(headBody)) return;
  if (baseBody.required !== true && headBody.required === true) {
    ctx.add(
      "request-body-became-required",
      "breaking",
      "request body",
      "the request body became required",
    );
  } else if (baseBody.required === true && headBody.required !== true) {
    ctx.add(
      "request-body-became-optional",
      "non-breaking",
      "request body",
      "the request body became optional",
    );
  }
  compareContent(ctx, baseBody.content, headBody.content, "request", "request body");
}

function compareResponses(ctx: OperationComparison, b: Operation, h: Operation): void {
  const baseResponses = isObject(b.node.responses) ? b.node.responses : {};
  const headResponses = isObject(h.node.responses) ? h.node.responses : {};
  for (const status of Object.keys(baseResponses)) {
    if (status in headResponses) continue;
    ctx.add(
      "response-status-removed",
      breakingIf(status.startsWith("2")),
      `response ${status}`,
      `response ${status} was removed`,
    );
  }
  for (const status of Object.keys(headResponses)) {
    if (!(status in baseResponses)) {
      ctx.add(
        "response-status-added",
        "non-breaking",
        `response ${status}`,
        `response ${status} was added`,
      );
      continue;
    }
    const br = ctx.base(baseResponses[status]);
    const hr = ctx.head(headResponses[status]);
    if (!isObject(br) || !isObject(hr)) continue;
    compareResponseHeaders(ctx, status, br, hr);
    compareContent(ctx, br.content, hr.content, "response", `response ${status}`);
  }
}

function compareResponseHeaders(
  ctx: OperationComparison,
  status: string,
  br: Json,
  hr: Json,
): void {
  const bh = isObject(br.headers) ? br.headers : {};
  const hh = isObject(hr.headers) ? hr.headers : {};
  const headNames = new Set(Object.keys(hh).map((name) => name.toLowerCase()));
  for (const [name, header] of Object.entries(bh)) {
    if (headNames.has(name.toLowerCase())) continue;
    const resolved = ctx.base(header);
    const required = isObject(resolved) && resolved.required === true;
    ctx.add(
      "response-header-removed",
      breakingIf(required),
      `response ${status} header ${name}`,
      "the response header was removed",
    );
  }
  const baseNames = new Set(Object.keys(bh).map((name) => name.toLowerCase()));
  for (const name of Object.keys(hh)) {
    if (baseNames.has(name.toLowerCase())) continue;
    ctx.add(
      "response-header-added",
      "non-breaking",
      `response ${status} header ${name}`,
      "a response header was added",
    );
  }
}

function compareContent(
  ctx: OperationComparison,
  baseContent: unknown,
  headContent: unknown,
  direction: Direction,
  location: string,
): void {
  const bc = isObject(baseContent) ? baseContent : {};
  const hc = isObject(headContent) ? headContent : {};
  for (const type of Object.keys(bc)) {
    if (type in hc) continue;
    ctx.add(
      "media-type-removed",
      "breaking",
      `${location} ${type}`,
      `media type ${type} was removed`,
    );
  }
  for (const type of Object.keys(hc)) {
    if (!(type in bc)) {
      ctx.add(
        "media-type-added",
        "non-breaking",
        `${location} ${type}`,
        `media type ${type} was added`,
      );
      continue;
    }
    compareSchema(
      ctx,
      (bc[type] as Json)?.schema,
      (hc[type] as Json)?.schema,
      direction,
      `${location} ${type} ·`,
      new Set(),
    );
  }
}
