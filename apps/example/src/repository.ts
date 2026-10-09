import type { Static } from "typebox";
import type { Book, CreateBook, UpdateBook } from "../contracts/schemas.ts";

export type BookRecord = Static<typeof Book>;

/**
 * An in-memory catalog. A real application would use a database client here; the lifecycle
 * methods show where it would connect and disconnect.
 */
export class BookRepository {
  #books = new Map<string, BookRecord>();
  #open = false;

  /** Opens the store and loads sample data. */
  start(): void {
    this.#open = true;
    for (
      const [title, author, year] of [
        ["The Left Hand of Darkness", "Ursula K. Le Guin", 1969],
        ["Kindred", "Octavia E. Butler", 1979],
      ] as const
    ) {
      this.create({ title, author, year, tags: ["fiction"] });
    }
  }

  stop(): void {
    this.#open = false;
  }

  /** For the health check. */
  ping(): void {
    if (!this.#open) throw new Error("the catalog is closed");
  }

  list(filter: { q?: string; tag?: string }, offset: number, limit: number) {
    const q = filter.q?.toLowerCase();
    const matching = [...this.#books.values()].filter((book) =>
      (q === undefined || `${book.title} ${book.author}`.toLowerCase().includes(q)) &&
      (filter.tag === undefined || book.tags.includes(filter.tag))
    );
    return { items: matching.slice(offset, offset + limit), total: matching.length };
  }

  get(id: string): BookRecord | undefined {
    return this.#books.get(id);
  }

  /** Returns `undefined` when a book with the same title and author exists. */
  create(input: Static<typeof CreateBook>): BookRecord | undefined {
    const duplicate = [...this.#books.values()].some((b) =>
      b.title === input.title && b.author === input.author
    );
    if (duplicate) return undefined;
    const book = { id: crypto.randomUUID(), tags: [], available: true, ...input };
    this.#books.set(book.id, book);
    return book;
  }

  update(id: string, changes: Static<typeof UpdateBook>): BookRecord | undefined {
    const current = this.#books.get(id);
    if (current === undefined) return undefined;
    const updated = { ...current, ...changes };
    this.#books.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.#books.delete(id);
  }
}
