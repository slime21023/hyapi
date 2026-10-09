// A representative API shared by the OpenAPI and CLI tests. It exercises named schemas and
// responses, every parameter location, styles, bodies, headers, security inheritance, and tags.
import Type from "typebox";
import {
  apiKey,
  defineApi,
  defineContract,
  defineResponse,
  defineSchema,
  defineSecurity,
  httpBearer,
  oauth2,
  Problem,
} from "@hyapi/core/contract";

const T = Type;

export const security = defineSecurity({
  bearer: httpBearer<{ subject: string }>({ bearerFormat: "JWT" }),
  key: apiKey<{ client: string }>({ in: "header", name: "x-api-key", description: "Partner key" }),
  oauth: oauth2<{ subject: string }>({
    flows: {
      clientCredentials: {
        tokenUrl: "https://auth.example.com/token",
        scopes: { "books:read": "Read books", "books:write": "Write books" },
      },
    },
  }),
});

export const Author = defineSchema(
  "Author",
  T.Object({ id: T.String({ format: "uuid" }), name: T.String() }),
);
export const Book = defineSchema(
  "Book",
  T.Object({
    id: T.String({ format: "uuid" }),
    title: T.String({ minLength: 1, description: "The book title" }),
    year: T.Integer({ format: "int32" }),
    authors: T.Array(Author),
    status: T.Union([T.Literal("available"), T.Literal("lent")]),
  }),
);
export const CreateBook = defineSchema("CreateBook", T.Omit(Book, ["id", "status"]));
export const BookList = defineSchema(
  "BookList",
  T.Object({ items: T.Array(Book), next: T.Optional(T.String()) }),
);
export const NotFound = defineResponse("NotFound", {
  description: "The resource does not exist.",
  body: Problem,
});

export const books = defineContract({
  securitySchemes: security,
  security: [{ bearer: [] }, { oauth: ["books:read"] }],
  tags: ["books"],
  operations: {
    listBooks: {
      method: "GET",
      path: "/books",
      summary: "List books",
      query: T.Object({
        limit: T.Optional(T.With(T.Integer({ minimum: 1, maximum: 100 }), { default: 20 })),
        ids: T.Optional(T.Array(T.String(), { description: "Filter by id" })),
        filter: T.Optional(T.Object({ title: T.String() })),
      }),
      styles: { query: { ids: { explode: false }, filter: { style: "deepObject" } } },
      responses: { 200: BookList },
    },
    getBook: {
      method: "GET",
      path: "/books/{id}",
      summary: "Get a book",
      params: T.Object({ id: T.String({ format: "uuid" }) }),
      headers: T.Object({ "if-none-match": T.Optional(T.String()) }),
      responses: { 200: Book, 404: NotFound },
    },
    createBook: {
      method: "POST",
      path: "/books",
      security: [{ oauth: ["books:write"] }],
      body: CreateBook,
      responses: {
        201: {
          description: "Created",
          body: Book,
          headers: T.Object({ location: T.String({ format: "uri-reference" }) }),
        },
      },
    },
    deleteBook: {
      method: "DELETE",
      path: "/books/{id}",
      deprecated: true,
      security: [{ oauth: ["books:write"] }],
      params: T.Object({ id: T.String({ format: "uuid" }) }),
      responses: { 204: { description: "Deleted" }, 404: NotFound },
    },
  },
});

export const system = defineContract({
  securitySchemes: security,
  tags: ["system"],
  operations: {
    health: {
      method: "GET",
      path: "/health",
      security: [],
      cookies: T.Object({ session: T.Optional(T.String()) }),
      responses: { 204: { description: "Healthy" } },
    },
    exportCatalog: {
      method: "GET",
      path: "/export",
      responses: {
        200: { description: "CSV export", body: T.String(), mediaType: "text/csv" },
      },
    },
  },
});

export const api = defineApi({
  info: {
    title: "Library API",
    version: "1.2.0",
    description: "A fixture API.",
    license: { name: "MIT", identifier: "MIT" },
  },
  servers: [{ url: "https://api.example.com", description: "Production" }],
  tags: [{ name: "books", description: "The catalog" }],
  securitySchemes: security,
  security: [{ key: [] }],
  contracts: [books, system],
});
