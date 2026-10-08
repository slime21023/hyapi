import type { TSchema } from "typebox";
import * as Format from "typebox/format";
import type { AnyContract, Api, HttpMethod, OperationSpec } from "./define.ts";
import type {
  BodyModel,
  ContractModel,
  HeaderModel,
  NamedResponseModel,
  OperationModel,
  ParameterLocation,
  ParameterModel,
  RequirementModel,
  ResponseModel,
  SecuritySchemeModel,
} from "./model.ts";
import { reasonPhrase } from "./reason.ts";
import { isNamedResponse, type NamedResponse, type ResponseSpec } from "./response.ts";
import { isSchema, schemaName } from "./schema.ts";
import type { SchemeSpec } from "./security.ts";

/** Stable identifiers for contract diagnostics. */
export type DiagnosticCode =
  | "invalid-api"
  | "duplicate-contract"
  | "invalid-security-scheme"
  | "security-schemes-mismatch"
  | "unknown-security-scheme"
  | "undeclared-scope"
  | "empty-security-requirement"
  | "duplicate-operation-id"
  | "duplicate-route"
  | "invalid-method"
  | "invalid-path"
  | "path-parameter-mismatch"
  | "optional-path-parameter"
  | "invalid-parameter-schema"
  | "unsupported-parameter-style"
  | "unknown-style-target"
  | "duplicate-header"
  | "reserved-header"
  | "invalid-body"
  | "body-on-safe-method"
  | "invalid-media-type"
  | "no-responses"
  | "invalid-status"
  | "invalid-response"
  | "body-not-allowed"
  | "unsupported-schema"
  | "unresolved-reference"
  | "invalid-component-name"
  | "duplicate-schema-name"
  | "duplicate-response-name"
  | "unnamed-schema"
  | "unknown-format";

/** One problem found in an API's contracts. */
export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly operationId?: string;
  /** A slash-separated path to the offending declaration, such as `getUser/responses/200/body`. */
  readonly location?: string;
}

/** The result of {@link checkContracts}. The model is present only when there are no errors. */
export type CheckResult =
  | {
    readonly ok: true;
    readonly model: ContractModel;
    readonly diagnostics: readonly Diagnostic[];
  }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const JSON_TYPE = "application/json";
const PROBLEM_TYPE = "application/problem+json";
const METHODS = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);
const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/;
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const RESERVED_HEADERS = new Set(["accept", "content-type", "authorization"]);
// OpenAPI-registered formats that HyAPI recognizes without a TypeBox format check. `int32` is
// enforced as a range by the runtime; the others are annotations.
const OPENAPI_FORMATS = new Set([
  "int32",
  "int64",
  "float",
  "double",
  "password",
  "byte",
  "binary",
]);
const NON_JSON_TYPES = new Set([
  "function",
  "constructor",
  "undefined",
  "void",
  "bigint",
  "symbol",
  "promise",
  "iterator",
  "asyncIterator",
]);
const MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "dependentSchemas"];
const SCHEMA_KEYWORDS = [
  "additionalProperties",
  "items",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
];
const ARRAY_KEYWORDS = ["anyOf", "allOf", "oneOf", "prefixItems"];

const LOCATIONS = [
  { field: "params", in: "path", style: "simple", explode: false, styles: ["simple"] },
  { field: "query", in: "query", style: "form", explode: true, styles: ["form", "deepObject"] },
  { field: "headers", in: "header", style: "simple", explode: false, styles: ["simple"] },
  { field: "cookies", in: "cookie", style: "form", explode: true, styles: ["form"] },
] as const;

type Dict = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectSchema(
  value: unknown,
): { properties: Readonly<Record<string, TSchema>>; required: ReadonlySet<string> } | undefined {
  if (!isSchema(value)) return undefined;
  const schema = value as unknown as Dict;
  if (schema.type !== "object" || !isRecord(schema.properties)) return undefined;
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  return {
    properties: schema.properties as Readonly<Record<string, TSchema>>,
    required: new Set(required),
  };
}

function parsePath(path: unknown): { params: string[] } | { error: string } {
  if (typeof path !== "string" || !path.startsWith("/")) {
    return { error: "the path must be a string that starts with '/'" };
  }
  if (/[?#]/.test(path)) return { error: "the path must not contain a query string or fragment" };
  const params: string[] = [];
  for (const match of path.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1]!;
    if (!PARAMETER_NAME.test(name)) {
      return { error: `path parameter '{${name}}' must be an identifier` };
    }
    if (params.includes(name)) return { error: `path parameter '{${name}}' appears twice` };
    params.push(name);
  }
  if (/[{}]/.test(path.replace(/\{[^{}]*\}/g, ""))) {
    return { error: "the path has unbalanced braces" };
  }
  return { params };
}

function freezeAll<T>(items: T[]): readonly T[] {
  return Object.freeze(items);
}

/**
 * Merges and normalizes an API's contracts into a {@link ContractModel}, reporting every problem
 * together. This is the only place where contracts are interpreted.
 */
export function checkContracts(api: Api): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const report = (
    severity: Diagnostic["severity"],
    code: DiagnosticCode,
    message: string,
    operationId?: string,
    location?: string,
  ) =>
    diagnostics.push({
      severity,
      code,
      message,
      ...(operationId === undefined ? {} : { operationId }),
      ...(location === undefined ? {} : { location }),
    });
  const error = (code: DiagnosticCode, message: string, operationId?: string, location?: string) =>
    report("error", code, message, operationId, location);
  const warn = (code: DiagnosticCode, message: string, operationId?: string, location?: string) =>
    report("warning", code, message, operationId, location);

  // --- Named schemas and responses, collected in first-reference order ---------------------------

  const schemas = new Map<string, TSchema>();
  const responses = new Map<string, { declared: NamedResponse; model: NamedResponseModel }>();

  const registerSchema = (schema: TSchema, operationId: string | undefined, at: string) => {
    const name = schemaName(schema);
    if (name === undefined) return;
    if (!COMPONENT_NAME.test(name)) {
      error(
        "invalid-component-name",
        `schema name '${name}' may contain only letters, digits, '.', '-', and '_'`,
        operationId,
        at,
      );
      return;
    }
    const existing = schemas.get(name);
    if (existing === undefined) schemas.set(name, schema);
    else if (existing !== schema && JSON.stringify(existing) !== JSON.stringify(schema)) {
      error(
        "duplicate-schema-name",
        `two different schemas are named '${name}'; give each schema a unique name`,
        operationId,
        at,
      );
    }
  };

  const inspectSchema = (root: unknown, operationId: string | undefined, location: string) => {
    const stack = new Set<object>();
    const visit = (node: unknown, at: string, scope: ReadonlySet<string>) => {
      if (typeof node !== "object" || node === null || stack.has(node)) return;
      stack.add(node);
      const schema = node as Dict;
      registerSchema(node as TSchema, operationId, at);
      if ("~codec" in schema) {
        error(
          "unsupported-schema",
          "codecs transform values in code and cannot be represented in JSON Schema",
          operationId,
          at,
        );
      }
      if ("~refine" in schema) {
        error(
          "unsupported-schema",
          "refinements check values in code and cannot be represented in JSON Schema",
          operationId,
          at,
        );
      }
      if (
        typeof schema.format === "string" && !OPENAPI_FORMATS.has(schema.format) &&
        !Format.Has(schema.format)
      ) {
        error(
          "unknown-format",
          `format '${schema.format}' is not checked by TypeBox or registered by OpenAPI; register ` +
            "it with TypeBox's Format.Set or remove it, so that documentation and validation agree",
          operationId,
          at,
        );
      }
      if (typeof schema.type === "string" && NON_JSON_TYPES.has(schema.type)) {
        error(
          "unsupported-schema",
          `the '${schema.type}' type cannot be represented in JSON Schema`,
          operationId,
          at,
        );
      }
      let inner = scope;
      if (isRecord(schema.$defs)) inner = new Set([...scope, ...Object.keys(schema.$defs)]);
      if (
        typeof schema.$ref === "string" && !schema.$ref.startsWith("#") && !inner.has(schema.$ref)
      ) {
        error(
          "unresolved-reference",
          `'$ref: ${schema.$ref}' does not refer to a definition in an enclosing T.Cyclic`,
          operationId,
          at,
        );
      }
      for (const keyword of MAP_KEYWORDS) {
        const map = schema[keyword];
        if (isRecord(map)) {
          for (const [key, value] of Object.entries(map)) {
            visit(value, `${at}/${keyword}/${key}`, inner);
          }
        }
      }
      for (const keyword of SCHEMA_KEYWORDS) visit(schema[keyword], `${at}/${keyword}`, inner);
      for (const keyword of ARRAY_KEYWORDS) {
        const list = schema[keyword];
        if (Array.isArray(list)) {
          list.forEach((value, i) => visit(value, `${at}/${keyword}/${i}`, inner));
        }
      }
      stack.delete(node);
    };
    visit(root, location, new Set());
  };

  const warnIfUnnamed = (schema: TSchema, operationId: string, at: string) => {
    if (objectSchema(schema) && schemaName(schema) === undefined) {
      warn(
        "unnamed-schema",
        "this object schema is emitted inline; name it with defineSchema so that consumers' code " +
          "generators produce a meaningful type name",
        operationId,
        at,
      );
    }
  };

  // --- API and security schemes ------------------------------------------------------------------

  if (!isRecord(api) || api.kind !== "hyapi.api") {
    error("invalid-api", "checkContracts expects a value created by defineApi");
    return { ok: false, diagnostics: freezeAll(diagnostics) };
  }
  if (typeof api.info?.title !== "string" || api.info.title === "") {
    error("invalid-api", "info.title must be a non-empty string", undefined, "info/title");
  }
  if (typeof api.info?.version !== "string" || api.info.version === "") {
    error("invalid-api", "info.version must be a non-empty string", undefined, "info/version");
  }

  const schemeSpecs = new Map<string, SchemeSpec>();
  for (const [name, scheme] of Object.entries(api.securitySchemes?.schemes ?? {})) {
    const spec = scheme?.spec;
    const at = `securitySchemes/${name}`;
    const invalid = (message: string) => error("invalid-security-scheme", message, undefined, at);
    if (!isRecord(spec)) {
      invalid(`security scheme '${name}' must be created with a scheme constructor`);
      continue;
    }
    if (spec.type === "apiKey" && (typeof spec.name !== "string" || spec.name === "")) {
      invalid(`API key scheme '${name}' needs a non-empty parameter name`);
    }
    if (spec.type === "openIdConnect" && !spec.openIdConnectUrl) {
      invalid(`OpenID Connect scheme '${name}' needs a discovery URL`);
    }
    if (spec.type === "oauth2") {
      const flows = Object.entries(spec.flows ?? {});
      if (flows.length === 0) invalid(`OAuth 2 scheme '${name}' needs at least one flow`);
      for (const [flow, value] of flows) {
        const needsAuthorization = flow === "implicit" || flow === "authorizationCode";
        const needsToken = flow !== "implicit";
        if (needsAuthorization && !value?.authorizationUrl) {
          invalid(`OAuth 2 flow '${flow}' of scheme '${name}' needs an authorizationUrl`);
        }
        if (needsToken && !value?.tokenUrl) {
          invalid(`OAuth 2 flow '${flow}' of scheme '${name}' needs a tokenUrl`);
        }
      }
    }
    schemeSpecs.set(name, spec);
  }

  const declaredScopes = (spec: SchemeSpec): ReadonlySet<string> | undefined =>
    spec.type === "oauth2"
      ? new Set(Object.values(spec.flows).flatMap((flow) => Object.keys(flow?.scopes ?? {})))
      : undefined;

  const normalizeSecurity = (
    requirements: unknown,
    operationId: string | undefined,
    at: string,
  ): RequirementModel[] => {
    if (!Array.isArray(requirements)) {
      error(
        "empty-security-requirement",
        "security must be a list of requirements",
        operationId,
        at,
      );
      return [];
    }
    return requirements.map((requirement, i) => {
      const entries = isRecord(requirement) ? Object.entries(requirement) : [];
      if (entries.length === 0) {
        error(
          "empty-security-requirement",
          "a security requirement must name at least one scheme; use 'security: []' for a " +
            "public operation",
          operationId,
          `${at}/${i}`,
        );
      }
      return freezeAll(entries.map(([scheme, scopes]) => {
        const spec = schemeSpecs.get(scheme);
        const list = Array.isArray(scopes) ? scopes.map(String) : [];
        if (spec === undefined) {
          error(
            "unknown-security-scheme",
            `security scheme '${scheme}' is not declared in defineSecurity`,
            operationId,
            `${at}/${i}/${scheme}`,
          );
        } else {
          const declared = declaredScopes(spec);
          for (const scope of declared ? list : []) {
            if (!declared!.has(scope)) {
              error(
                "undeclared-scope",
                `scope '${scope}' is not declared by any flow of OAuth 2 scheme '${scheme}'`,
                operationId,
                `${at}/${i}/${scheme}`,
              );
            }
          }
        }
        return Object.freeze({ scheme, scopes: freezeAll(list) });
      }));
    });
  };

  const rootSecurity = api.security === undefined
    ? undefined
    : normalizeSecurity(api.security, undefined, "security");

  // --- Contracts and operations ------------------------------------------------------------------

  const contracts = Array.isArray(api.contracts) ? api.contracts as readonly AnyContract[] : [];
  if (!Array.isArray(api.contracts)) {
    error("invalid-api", "contracts must be a list", undefined, "contracts");
  }

  const operations: OperationModel[] = [];
  const operationOwners = new Map<string, number>();
  const routes = new Map<string, string>();
  const seenContracts = new Set<unknown>();

  contracts.forEach((contract, index) => {
    const contractAt = `contracts/${index}`;
    if (!isRecord(contract) || contract.kind !== "hyapi.contract") {
      error(
        "invalid-api",
        "every contract must be created with defineContract",
        undefined,
        contractAt,
      );
      return;
    }
    if (seenContracts.has(contract)) {
      error("duplicate-contract", "the same contract is listed twice", undefined, contractAt);
      return;
    }
    seenContracts.add(contract);
    if (
      contract.securitySchemes !== undefined && contract.securitySchemes !== api.securitySchemes
    ) {
      error(
        "security-schemes-mismatch",
        "the contract uses a different defineSecurity module than defineApi; both must import " +
          "the same value",
        undefined,
        `${contractAt}/securitySchemes`,
      );
    }
    const contractSecurity = contract.security === undefined
      ? undefined
      : normalizeSecurity(contract.security, undefined, `${contractAt}/security`);

    for (const [operationId, declared] of Object.entries(contract.operations ?? {})) {
      const owner = operationOwners.get(operationId);
      if (owner !== undefined) {
        error(
          "duplicate-operation-id",
          `operationId '${operationId}' is declared by contracts ${owner} and ${index}`,
          operationId,
        );
        continue;
      }
      operationOwners.set(operationId, index);
      const operation = normalizeOperation(
        operationId,
        declared as OperationSpec,
        index,
        contract,
        contractSecurity,
      );
      if (operation === undefined) continue;
      const route = `${operation.method} ${operation.path.replace(/\{[^{}]*\}/g, "{}")}`;
      const clash = routes.get(route);
      if (clash !== undefined) {
        error(
          "duplicate-route",
          `'${operation.method} ${operation.path}' matches the same requests as operation '${clash}'`,
          operationId,
          `${operationId}/path`,
        );
      } else routes.set(route, operationId);
      operations.push(operation);
    }
  });

  function normalizeOperation(
    operationId: string,
    op: OperationSpec,
    contractIndex: number,
    contract: AnyContract,
    contractSecurity: RequirementModel[] | undefined,
  ): OperationModel | undefined {
    if (!isRecord(op)) {
      error("invalid-api", "an operation must be an object", operationId, operationId);
      return undefined;
    }
    if (!METHODS.has(op.method)) {
      error(
        "invalid-method",
        `'${String(op.method)}' is not an HTTP method`,
        operationId,
        `${operationId}/method`,
      );
    }
    const parsed = parsePath(op.path);
    if ("error" in parsed) {
      error("invalid-path", parsed.error, operationId, `${operationId}/path`);
    }
    const pathParameters = "params" in parsed ? parsed.params : [];

    // Parameters
    const parameters: ParameterModel[] = [];
    const styles = isRecord(op.styles) ? op.styles : {};
    for (const location of LOCATIONS) {
      const declared = op[location.field];
      const overrides = isRecord(styles[location.field]) ? styles[location.field] as Dict : {};
      const at = `${operationId}/${location.field}`;
      if (declared === undefined) {
        for (const name of Object.keys(overrides)) {
          error(
            "unknown-style-target",
            `'${name}' is not a declared ${location.in} parameter`,
            operationId,
            `${operationId}/styles/${location.field}/${name}`,
          );
        }
        continue;
      }
      const object = objectSchema(declared);
      if (object === undefined) {
        error(
          "invalid-parameter-schema",
          `${location.field} must be a T.Object schema`,
          operationId,
          at,
        );
        continue;
      }
      inspectSchema(declared, operationId, at);
      for (const name of Object.keys(overrides)) {
        if (!(name in object.properties)) {
          error(
            "unknown-style-target",
            `'${name}' is not a declared ${location.in} parameter`,
            operationId,
            `${operationId}/styles/${location.field}/${name}`,
          );
        }
      }
      const seenHeaders = new Set<string>();
      for (const [name, schema] of Object.entries(object.properties)) {
        const paramAt = `${at}/${name}`;
        const override = isRecord(overrides[name]) ? overrides[name] as Dict : {};
        const style = (override.style ?? location.style) as ParameterModel["style"];
        const explode = typeof override.explode === "boolean" ? override.explode : location.explode;
        if (!(location.styles as readonly string[]).includes(style)) {
          error(
            "unsupported-parameter-style",
            `style '${style}' is not supported for ${location.in} parameters; supported: ${
              location.styles.join(", ")
            }`,
            operationId,
            paramAt,
          );
        }
        if (style === "deepObject") {
          if (!objectSchema(schema)) {
            error(
              "unsupported-parameter-style",
              "deepObject requires an object schema",
              operationId,
              paramAt,
            );
          }
          if (!explode) {
            error(
              "unsupported-parameter-style",
              "deepObject requires explode: true",
              operationId,
              paramAt,
            );
          }
        }
        if (location.in === "header") {
          const lower = name.toLowerCase();
          if (RESERVED_HEADERS.has(lower)) {
            error(
              "reserved-header",
              `OpenAPI ignores a header parameter named '${name}'; declare media types in body and responses, and credentials in securitySchemes`,
              operationId,
              paramAt,
            );
          }
          if (seenHeaders.has(lower)) {
            error(
              "duplicate-header",
              `header '${name}' is declared twice (header names are case-insensitive)`,
              operationId,
              paramAt,
            );
          }
          seenHeaders.add(lower);
        }
        const required = object.required.has(name);
        if (location.in === "path" && !required) {
          error(
            "optional-path-parameter",
            `path parameter '${name}' must be required; remove T.Optional`,
            operationId,
            paramAt,
          );
        }
        parameters.push(Object.freeze({
          name,
          in: location.in as ParameterLocation,
          required,
          schema,
          style,
          explode,
          hasDefault: isRecord(schema) && "default" in schema,
        }));
      }
    }
    const pathNames = parameters.filter((p) => p.in === "path").map((p) => p.name);
    const missing = pathParameters.filter((name) => !pathNames.includes(name));
    const extra = pathNames.filter((name) => !pathParameters.includes(name));
    if (missing.length > 0) {
      error(
        "path-parameter-mismatch",
        `path parameters missing from params: ${missing.join(", ")}`,
        operationId,
        `${operationId}/params`,
      );
    }
    if (extra.length > 0) {
      error(
        "path-parameter-mismatch",
        `params not in the path: ${extra.join(", ")}`,
        operationId,
        `${operationId}/params`,
      );
    }

    // Body
    let body: BodyModel | undefined;
    if (op.body !== undefined) {
      const at = `${operationId}/body`;
      const full = isSchema(op.body) ? undefined : op.body as Dict;
      const schema = full === undefined ? op.body as TSchema : full.schema;
      if (!isSchema(schema)) {
        error(
          "invalid-body",
          "body must be a schema or { schema, mediaType?, required?, description? }",
          operationId,
          at,
        );
      } else {
        const mediaType = typeof full?.mediaType === "string" ? full.mediaType : JSON_TYPE;
        if (!MEDIA_TYPE.test(mediaType)) {
          error("invalid-media-type", `'${mediaType}' is not a media type`, operationId, at);
        }
        if (op.method === "GET" || op.method === "HEAD") {
          warn(
            "body-on-safe-method",
            `${op.method} requests should not have a body; many clients and proxies drop it`,
            operationId,
            at,
          );
        }
        inspectSchema(schema, operationId, at);
        warnIfUnnamed(schema, operationId, at);
        body = Object.freeze({
          schema,
          mediaType,
          required: full?.required !== false,
          ...(typeof full?.description === "string" ? { description: full.description } : {}),
        });
      }
    }

    // Responses
    const responseModels: ResponseModel[] = [];
    const entries = isRecord(op.responses) ? Object.entries(op.responses) : [];
    if (entries.length === 0) {
      error(
        "no-responses",
        "an operation must declare at least one response",
        operationId,
        `${operationId}/responses`,
      );
    }
    for (const [key, declaredResponse] of entries) {
      const value: unknown = declaredResponse;
      const at = `${operationId}/responses/${key}`;
      const status = Number(key);
      if (!Number.isInteger(status) || status < 100 || status > 599 || String(status) !== key) {
        error(
          "invalid-status",
          `'${key}' is not an HTTP status code between 100 and 599`,
          operationId,
          at,
        );
        continue;
      }
      let model: Omit<ResponseModel, "status"> | undefined;
      if (isNamedResponse(value)) {
        model = namedResponse(value, operationId, at);
      } else if (isSchema(value)) {
        model = normalizeResponse(
          { description: reasonPhrase(status), body: value },
          operationId,
          at,
        );
      } else if (isRecord(value) && typeof value.description === "string") {
        model = normalizeResponse(value as unknown as ResponseSpec, operationId, at);
      } else {
        error(
          "invalid-response",
          "a response must be a schema, { description, body?, mediaType?, headers? }, or a defineResponse value",
          operationId,
          at,
        );
      }
      if (model === undefined) continue;
      if (model.body && (status < 200 || status === 204 || status === 205 || status === 304)) {
        error("body-not-allowed", `status ${status} responses cannot have a body`, operationId, at);
      }
      responseModels.push(Object.freeze({ status, ...model }));
    }
    responseModels.sort((a, b) => a.status - b.status);

    // Security
    let security: RequirementModel[];
    let securityOrigin: OperationModel["securityOrigin"];
    if (op.security !== undefined) {
      security = normalizeSecurity(op.security, operationId, `${operationId}/security`);
      securityOrigin = "operation";
    } else if (contractSecurity !== undefined) {
      security = contractSecurity;
      securityOrigin = "contract";
    } else if (rootSecurity !== undefined) {
      security = rootSecurity;
      securityOrigin = "api";
    } else {
      security = [];
      securityOrigin = "none";
    }

    return Object.freeze({
      operationId,
      method: op.method,
      path: typeof op.path === "string" ? op.path : "",
      pathParameters: freezeAll(pathParameters),
      parameters: freezeAll(parameters),
      ...(body === undefined ? {} : { body }),
      responses: freezeAll(responseModels),
      security: freezeAll(security),
      securityOrigin,
      tags: freezeAll([...(op.tags ?? contract.tags ?? [])]),
      ...(op.summary === undefined ? {} : { summary: op.summary }),
      ...(op.description === undefined ? {} : { description: op.description }),
      deprecated: op.deprecated === true,
      contract: contractIndex,
    });
  }

  function normalizeResponse(
    spec: ResponseSpec,
    operationId: string,
    at: string,
  ): Omit<ResponseModel, "status" | "name"> {
    let responseBody: ResponseModel["body"];
    if (spec.body !== undefined) {
      if (!isSchema(spec.body)) {
        error("invalid-response", "a response body must be a schema", operationId, `${at}/body`);
      } else {
        // Matched by component name, not identity, so a second copy of HyAPI (for example the
        // CLI's) still recognizes the built-in Problem schema.
        const mediaType = spec.mediaType ??
          (schemaName(spec.body) === "Problem" ? PROBLEM_TYPE : JSON_TYPE);
        if (!MEDIA_TYPE.test(mediaType)) {
          error(
            "invalid-media-type",
            `'${mediaType}' is not a media type`,
            operationId,
            `${at}/mediaType`,
          );
        }
        inspectSchema(spec.body, operationId, `${at}/body`);
        warnIfUnnamed(spec.body, operationId, `${at}/body`);
        responseBody = Object.freeze({ schema: spec.body, mediaType });
      }
    }
    const headers: HeaderModel[] = [];
    if (spec.headers !== undefined) {
      const object = objectSchema(spec.headers);
      if (object === undefined) {
        error(
          "invalid-response",
          "response headers must be a T.Object schema",
          operationId,
          `${at}/headers`,
        );
      } else {
        inspectSchema(spec.headers, operationId, `${at}/headers`);
        const seen = new Set<string>();
        for (const [name, schema] of Object.entries(object.properties)) {
          const lower = name.toLowerCase();
          if (seen.has(lower)) {
            error(
              "duplicate-header",
              `response header '${name}' is declared twice (header names are case-insensitive)`,
              operationId,
              `${at}/headers/${name}`,
            );
          }
          seen.add(lower);
          headers.push(Object.freeze({ name, required: object.required.has(name), schema }));
        }
      }
    }
    return {
      description: spec.description,
      ...(responseBody === undefined ? {} : { body: responseBody }),
      headers: freezeAll(headers),
    };
  }

  function namedResponse(
    declared: NamedResponse,
    operationId: string,
    at: string,
  ): Omit<ResponseModel, "status"> {
    const existing = responses.get(declared.name);
    if (existing !== undefined) {
      if (existing.declared !== declared) {
        error(
          "duplicate-response-name",
          `two different responses are named '${declared.name}'; give each response a unique name`,
          operationId,
          at,
        );
      }
      return { ...existing.model.response, name: declared.name };
    }
    if (!COMPONENT_NAME.test(declared.name)) {
      error(
        "invalid-component-name",
        `response name '${declared.name}' may contain only letters, digits, '.', '-', and '_'`,
        operationId,
        at,
      );
    }
    const response = Object.freeze(normalizeResponse(declared.spec, operationId, at));
    responses.set(declared.name, {
      declared,
      model: Object.freeze({ name: declared.name, response }),
    });
    return { ...response, name: declared.name };
  }

  const ok = !diagnostics.some((d) => d.severity === "error");
  if (!ok) return { ok: false, diagnostics: freezeAll(diagnostics) };

  const model: ContractModel = Object.freeze({
    info: api.info,
    servers: freezeAll([...(api.servers ?? [])]),
    tags: freezeAll([...(api.tags ?? [])]),
    securitySchemes: freezeAll(
      [...schemeSpecs].map(([name, spec]): SecuritySchemeModel => Object.freeze({ name, spec })),
    ),
    security: rootSecurity === undefined ? undefined : freezeAll(rootSecurity),
    operations: freezeAll(operations),
    schemas: freezeAll([...schemas].map(([name, schema]) => Object.freeze({ name, schema }))),
    responses: freezeAll([...responses.values()].map((entry) => entry.model)),
  });
  return { ok: true, model, diagnostics: freezeAll(diagnostics) };
}
