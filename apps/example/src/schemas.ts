import Type from "typebox";

export const UserSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  email: Type.String({ format: "email", maxLength: 320 }),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
}, { additionalProperties: false });

export const CreateUserSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  email: Type.String({ format: "email", maxLength: 320 }),
}, { additionalProperties: false });

export const UpdateUserSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  email: Type.Optional(Type.String({ format: "email", maxLength: 320 })),
}, { additionalProperties: false, minProperties: 1 });

export const UserIdParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
}, { additionalProperties: false });

export const UserListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
}, { additionalProperties: false });

export const UserListResponseSchema = Type.Object({
  data: Type.Array(UserSchema),
  total: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

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

export type User = Type.Static<typeof UserSchema>;
export type CreateUserInput = Type.Static<typeof CreateUserSchema>;
export type UpdateUserInput = Type.Static<typeof UpdateUserSchema>;
export type UserListQuery = Type.Static<typeof UserListQuerySchema>;
