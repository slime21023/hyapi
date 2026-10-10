import { implement } from "@hyapi/core";
import { books } from "../contracts/books.ts";
import type { BookRepository } from "./repository.ts";

function csvField(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Binds the books contract to a repository. Dependencies arrive through the closure. */
export function booksImplementation(repository: BookRepository) {
  return implement(books, {
    listBooks: ({ query }) => {
      const page = repository.list(
        {
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.tag === undefined ? {} : { tag: query.tag }),
        },
        query.offset,
        query.limit,
      );
      return { status: 200, body: { ...page, offset: query.offset, limit: query.limit } };
    },

    getBook: ({ params }) => {
      const book = repository.get(params.id);
      return book
        ? { status: 200, body: book }
        : { status: 404, body: { title: "Book not found", detail: params.id } };
    },

    createBook: ({ body }, ctx) => {
      const book = repository.create(body);
      if (book === undefined) {
        return {
          status: 409,
          body: { title: "Duplicate book", detail: `${body.title} by ${body.author}` },
        };
      }
      console.log(`book ${book.id} added by ${ctx.security.bearer.subject}`);
      return { status: 201, body: book, headers: { location: `/books/${book.id}` } };
    },

    updateBook: ({ params, body }) => {
      const book = repository.update(params.id, body);
      return book
        ? { status: 200, body: book }
        : { status: 404, body: { title: "Book not found", detail: params.id } };
    },

    deleteBook: ({ params }) =>
      repository.delete(params.id)
        ? { status: 204 }
        : { status: 404, body: { title: "Book not found", detail: params.id } },

    exportBooks: () => {
      const { items } = repository.list({}, 0, Number.MAX_SAFE_INTEGER);
      const rows = items.map((b) => [b.id, b.title, b.author, b.year, b.available].map(csvField));
      return {
        status: 200,
        body: [["id", "title", "author", "year", "available"], ...rows].map((r) => r.join(","))
          .join("\n") + "\n",
      };
    },
  });
}
