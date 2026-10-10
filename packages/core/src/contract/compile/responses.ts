// Responses: bodies, headers, named responses, and the status codes they are declared under.
import { isMediaType, JSON_MEDIA_TYPE, PROBLEM_MEDIA_TYPE, reasonPhrase } from "../../base/http.ts";
import { isRecord, isSchema, objectSchema, schemaName } from "../../base/typebox.ts";
import type { OperationSpec } from "../declare/contract.ts";
import { isNamedResponse, type NamedResponse, type ResponseSpec } from "../declare/response.ts";
import type { HeaderModel, ResponseModel } from "../model.ts";
import type { OperationContext } from "./context.ts";

/** Normalizes the body of a response declaration. */
function normalizeResponseBody(
  spec: ResponseSpec,
  operationId: string,
  at: string,
  ctx: OperationContext,
): ResponseModel["body"] {
  if (spec.body === undefined) return undefined;
  const { report, inspector } = ctx;
  if (!isSchema(spec.body)) {
    report.error("invalid-response", "a response body must be a schema", operationId, `${at}/body`);
    return undefined;
  }
  // Matched by component name, not identity, so a second copy of HyAPI (for example the CLI's)
  // still recognizes the built-in Problem schema.
  const mediaType = spec.mediaType ??
    (schemaName(spec.body) === "Problem" ? PROBLEM_MEDIA_TYPE : JSON_MEDIA_TYPE);
  if (!isMediaType(mediaType)) {
    report.error(
      "invalid-media-type",
      `'${mediaType}' is not a media type`,
      operationId,
      `${at}/mediaType`,
    );
  }
  inspector.inspect(spec.body, operationId, `${at}/body`);
  inspector.warnIfUnnamed(spec.body, operationId, `${at}/body`);
  return { schema: spec.body, mediaType };
}

/** Normalizes the headers of a response declaration. */
function normalizeResponseHeaders(
  spec: ResponseSpec,
  operationId: string,
  at: string,
  ctx: OperationContext,
): HeaderModel[] {
  if (spec.headers === undefined) return [];
  const { report, inspector } = ctx;
  const object = objectSchema(spec.headers);
  if (object === undefined) {
    report.error(
      "invalid-response",
      "response headers must be a T.Object schema",
      operationId,
      `${at}/headers`,
    );
    return [];
  }
  inspector.inspect(spec.headers, operationId, `${at}/headers`);
  const seen = new Set<string>();
  const headers: HeaderModel[] = [];
  for (const [name, schema] of Object.entries(object.properties)) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      report.error(
        "duplicate-header",
        `response header '${name}' is declared twice (header names are case-insensitive)`,
        operationId,
        `${at}/headers/${name}`,
      );
    }
    seen.add(lower);
    headers.push({ name, required: object.required.has(name), schema });
  }
  return headers;
}

/** Normalizes one response declaration (schema or full form). */
function normalizeResponse(
  spec: ResponseSpec,
  operationId: string,
  at: string,
  ctx: OperationContext,
): Omit<ResponseModel, "status" | "name"> {
  const body = normalizeResponseBody(spec, operationId, at, ctx);
  return {
    description: spec.description,
    ...(body === undefined ? {} : { body }),
    headers: normalizeResponseHeaders(spec, operationId, at, ctx),
  };
}

/** Normalizes a `defineResponse` value once, and reuses it wherever it is referenced. */
function namedResponse(
  declared: NamedResponse,
  operationId: string,
  at: string,
  ctx: OperationContext,
): Omit<ResponseModel, "status"> {
  return ctx.components.addResponse(
    declared,
    operationId,
    at,
    () => normalizeResponse(declared.spec, operationId, at, ctx),
  );
}

/** Normalizes the responses of an operation, ordered by status. */
export function normalizeResponses(
  operationId: string,
  op: OperationSpec,
  ctx: OperationContext,
): ResponseModel[] {
  const { report } = ctx;
  const models: ResponseModel[] = [];
  const entries = isRecord(op.responses) ? Object.entries(op.responses) : [];
  if (entries.length === 0) {
    report.error(
      "no-responses",
      "an operation must declare at least one response",
      operationId,
      `${operationId}/responses`,
    );
  }
  for (const [key, value] of entries as [string, unknown][]) {
    const at = `${operationId}/responses/${key}`;
    const status = Number(key);
    if (!Number.isInteger(status) || status < 100 || status > 599 || String(status) !== key) {
      report.error(
        "invalid-status",
        `'${key}' is not an HTTP status code between 100 and 599`,
        operationId,
        at,
      );
      continue;
    }
    let model: Omit<ResponseModel, "status"> | undefined;
    if (isNamedResponse(value)) {
      model = namedResponse(value, operationId, at, ctx);
    } else if (isSchema(value)) {
      model = normalizeResponse(
        { description: reasonPhrase(status), body: value },
        operationId,
        at,
        ctx,
      );
    } else if (isRecord(value) && typeof value.description === "string") {
      model = normalizeResponse(value as unknown as ResponseSpec, operationId, at, ctx);
    } else {
      report.error(
        "invalid-response",
        "a response must be a schema, { description, body?, mediaType?, headers? }, or a defineResponse value",
        operationId,
        at,
      );
    }
    if (model === undefined) continue;
    if (model.body && (status < 200 || status === 204 || status === 205 || status === 304)) {
      report.error(
        "body-not-allowed",
        `status ${status} responses cannot have a body`,
        operationId,
        at,
      );
    }
    models.push({ status, ...model });
  }
  return models.sort((a, b) => a.status - b.status);
}
