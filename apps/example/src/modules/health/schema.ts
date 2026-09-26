import Type from "typebox";

export const HealthResponseSchema = Type.Object({
  status: Type.Literal("ok"),
  service: Type.String(),
  timestamp: Type.String({ format: "date-time" }),
}, { additionalProperties: false });

export const ReadyResponseSchema = Type.Object({
  status: Type.Literal("ready"),
  service: Type.String(),
  timestamp: Type.String({ format: "date-time" }),
}, { additionalProperties: false });

export const NotReadyResponseSchema = Type.Object({
  status: Type.Literal("unavailable"),
  service: Type.String(),
  timestamp: Type.String({ format: "date-time" }),
  providers: Type.Array(Type.Object({
    status: Type.String(),
    provider: Type.String(),
    detail: Type.Optional(Type.String()),
  })),
}, { additionalProperties: false });
