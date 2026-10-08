import Type from "typebox";
import { defineResponse, defineSchema, Problem } from "@hyapi/core/contract";

const T = Type;

export const Book = defineSchema(
  "Book",
  T.Object({
    id: T.String({ format: "uuid" }),
    title: T.String({ minLength: 1, maxLength: 200 }),
    author: T.String({ minLength: 1, maxLength: 120 }),
    year: T.Integer({ format: "int32", minimum: 0, maximum: 3000 }),
    tags: T.Array(T.String({ maxLength: 32 }), { maxItems: 10 }),
    available: T.Boolean(),
  }),
);

export const CreateBook = defineSchema(
  "CreateBook",
  T.Object({
    title: T.String({ minLength: 1, maxLength: 200 }),
    author: T.String({ minLength: 1, maxLength: 120 }),
    year: T.Integer({ format: "int32", minimum: 0, maximum: 3000 }),
    tags: T.Optional(T.Array(T.String({ maxLength: 32 }), { maxItems: 10 })),
  }),
);

export const UpdateBook = defineSchema("UpdateBook", T.Partial(CreateBook));

export const BookPage = defineSchema(
  "BookPage",
  T.Object({
    items: T.Array(Book),
    total: T.Integer({ minimum: 0 }),
    offset: T.Integer({ minimum: 0 }),
    limit: T.Integer({ minimum: 1 }),
  }),
);

export const NotFound = defineResponse("NotFound", {
  description: "The book does not exist.",
  body: Problem,
});

export const Conflict = defineResponse("Conflict", {
  description: "A book with the same title and author already exists.",
  body: Problem,
});
