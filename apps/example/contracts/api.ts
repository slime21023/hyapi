import { defineApi } from "@hyapi/core/contract";
import { books } from "./books.ts";
import { security } from "./security.ts";
import { system } from "./system.ts";

const info = {
  title: "Library API",
  version: "0.1.0",
  description: "The HyAPI example: a small library catalog.",
  license: { name: "MIT", identifier: "MIT" },
};

/** The whole API: the application serves it, and its operators read this document. */
export const api = defineApi({
  info,
  tags: [
    { name: "books", description: "The catalog" },
    { name: "system", description: "Operations" },
  ],
  securitySchemes: security,
  contracts: [books, system],
});

/** The document for library clients: the catalog, without the operational endpoints. */
export const publicApi = defineApi({
  info: { ...info, title: "Library API (public)" },
  tags: [{ name: "books", description: "The catalog" }],
  securitySchemes: security,
  contracts: [books],
});
