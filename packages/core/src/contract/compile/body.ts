// Request bodies.
import type { TSchema } from "typebox";
import { isJsonMediaType, isMediaType, isTextMediaType, JSON_MEDIA_TYPE } from "../../base/http.ts";
import { type Dict, isSchema } from "../../base/typebox.ts";
import type { OperationSpec } from "../declare/contract.ts";
import type { BodyModel } from "../model.ts";
import type { OperationContext } from "./operation.ts";

/** Normalizes the request body of an operation. */
export function normalizeBody(
  operationId: string,
  op: OperationSpec,
  ctx: OperationContext,
): BodyModel | undefined {
  if (op.body === undefined) return undefined;
  const { report, inspector } = ctx;
  const at = `${operationId}/body`;
  const full = isSchema(op.body) ? undefined : op.body as Dict;
  const schema = full === undefined ? op.body as TSchema : full.schema;
  if (!isSchema(schema)) {
    report.error(
      "invalid-body",
      "body must be a schema or { schema, mediaType?, required?, description? }",
      operationId,
      at,
    );
    return undefined;
  }
  const mediaType = typeof full?.mediaType === "string" ? full.mediaType : JSON_MEDIA_TYPE;
  if (!isMediaType(mediaType)) {
    report.error("invalid-media-type", `'${mediaType}' is not a media type`, operationId, at);
  }
  // Other media types reach the handler as bytes, so only a binary string describes them.
  const bytes = !isJsonMediaType(mediaType) && !isTextMediaType(mediaType);
  const schemaFields = schema as unknown as Dict;
  if (bytes && !(schemaFields.type === "string" && schemaFields.format === "binary")) {
    report.error(
      "unsupported-body-schema",
      `${mediaType} bodies reach the handler as bytes; declare the schema as ` +
        'T.String({ format: "binary" }) (form and multipart bodies are not supported yet)',
      operationId,
      at,
    );
  }
  if (op.method === "GET" || op.method === "HEAD") {
    report.warn(
      "body-on-safe-method",
      `${op.method} requests should not have a body; many clients and proxies drop it`,
      operationId,
      at,
    );
  }
  inspector.inspect(schema, operationId, at);
  inspector.warnIfUnnamed(schema, operationId, at);
  return {
    schema,
    mediaType,
    required: full?.required !== false,
    ...(typeof full?.description === "string" ? { description: full.description } : {}),
  };
}
