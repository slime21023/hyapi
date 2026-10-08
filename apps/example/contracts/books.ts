import Type from "typebox";
import { defineContract } from "@hyapi/core/contract";
import { Book, BookPage, Conflict, CreateBook, NotFound, UpdateBook } from "./schemas.ts";
import { security } from "./security.ts";

const T = Type;
const BookId = T.Object({ id: T.String({ format: "uuid" }) });

export const books = defineContract({
  securitySchemes: security,
  // Writing requires a librarian; each read operation opts out with `security: []`.
  security: [{ bearer: ["books:write"] }],
  tags: ["books"],
  operations: {
    listBooks: {
      method: "GET",
      path: "/books",
      summary: "List books",
      security: [],
      query: T.Object({
        q: T.Optional(T.String({ maxLength: 100, description: "Matches title or author" })),
        tag: T.Optional(T.String()),
        offset: T.Optional(T.With(T.Integer({ minimum: 0 }), { default: 0 })),
        limit: T.Optional(T.With(T.Integer({ minimum: 1, maximum: 100 }), { default: 20 })),
      }),
      responses: { 200: BookPage },
    },
    getBook: {
      method: "GET",
      path: "/books/{id}",
      summary: "Get a book",
      security: [],
      params: BookId,
      responses: { 200: Book, 404: NotFound },
    },
    createBook: {
      method: "POST",
      path: "/books",
      summary: "Add a book",
      body: CreateBook,
      responses: {
        201: {
          description: "Created",
          body: Book,
          headers: T.Object({ location: T.String({ format: "uri-reference" }) }),
        },
        409: Conflict,
      },
    },
    updateBook: {
      method: "PATCH",
      path: "/books/{id}",
      summary: "Change a book",
      params: BookId,
      body: UpdateBook,
      responses: { 200: Book, 404: NotFound },
    },
    deleteBook: {
      method: "DELETE",
      path: "/books/{id}",
      summary: "Remove a book",
      params: BookId,
      responses: { 204: { description: "Removed" }, 404: NotFound },
    },
    exportBooks: {
      method: "GET",
      path: "/books.csv",
      summary: "Export the catalog as CSV",
      security: [],
      responses: {
        200: { description: "The catalog", body: T.String(), mediaType: "text/csv" },
      },
    },
  },
});
