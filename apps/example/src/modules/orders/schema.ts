import Type from "typebox";

export const CreateOrderSchema = Type.Object({
  userId: Type.String({ format: "uuid" }),
  sku: Type.String({ minLength: 1, maxLength: 120 }),
}, { additionalProperties: false });

export const OrderSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  userId: Type.String({ format: "uuid" }),
  sku: Type.String({ minLength: 1, maxLength: 120 }),
  createdAt: Type.String({ format: "date-time" }),
}, { additionalProperties: false });
