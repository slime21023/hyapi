import Type, {
  type TInteger,
  type TLiteral,
  type TNumber,
  type TObject,
  type TOptional,
  type TRecord,
  type TSchema,
  type TString,
  type TUnion,
} from "typebox";
import { withSchemaName } from "../../base/typebox.ts";

/**
 * Names a schema so that it is emitted as `#/components/schemas/<name>` and referenced by `$ref`.
 *
 * Returns a copy of the schema that carries the name, so the input schema is never mutated.
 *
 * @example
 * ```ts
 * export const User = defineSchema("User", T.Object({ id: T.String(), name: T.String() }));
 * ```
 */
export function defineSchema<Schema extends TSchema>(name: string, schema: Schema): Schema {
  return withSchemaName(schema, name);
}

type THealthStatus = TUnion<[TLiteral<"healthy">, TLiteral<"degraded">, TLiteral<"unhealthy">]>;

/** The type of the {@link HealthReport} schema. */
type THealthReport = TObject<{
  status: THealthStatus;
  checks: TRecord<
    string,
    TObject<{ status: THealthStatus; durationMs: TNumber; detail: TOptional<TString> }>
  >;
}>;

/** The type of the {@link Problem} schema. */
type TProblem = TObject<{
  type: TOptional<TString>;
  title: TOptional<TString>;
  status: TOptional<TInteger>;
  detail: TOptional<TString>;
  instance: TOptional<TString>;
}>;

const HealthStatus: THealthStatus = Type.Union([
  Type.Literal("healthy"),
  Type.Literal("degraded"),
  Type.Literal("unhealthy"),
]);

/**
 * The report produced by the runtime's `createHealth`. Declare it as the response of a health
 * operation, for example `responses: { 200: HealthReport, 503: HealthReport }`.
 */
export const HealthReport: THealthReport = defineSchema(
  "HealthReport",
  Type.Object({
    status: HealthStatus,
    checks: Type.Record(
      Type.String(),
      Type.Object({
        status: HealthStatus,
        durationMs: Type.Number(),
        detail: Type.Optional(Type.String()),
      }),
    ),
  }),
);

/**
 * The RFC 9457 problem details schema. A response whose body is `Problem` is served as
 * `application/problem+json`.
 */
export const Problem: TProblem = defineSchema(
  "Problem",
  Type.Object({
    type: Type.Optional(Type.String({ format: "uri-reference" })),
    title: Type.Optional(Type.String()),
    status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String({ format: "uri-reference" })),
  }, { additionalProperties: true }),
);
