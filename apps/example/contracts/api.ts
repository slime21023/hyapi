import { defineApi } from "@hyapi/core/contract";
import { books } from "./books.ts";
import { security } from "./security.ts";
import { system } from "./system.ts";

export const api = defineApi({
  info: {
    title: "Library API",
    version: "0.1.0",
    description: "The HyAPI example: a small library catalog.",
    license: { name: "MIT", identifier: "MIT" },
  },
  tags: [
    { name: "books", description: "The catalog" },
    { name: "system", description: "Operations" },
  ],
  securitySchemes: security,
  contracts: [books, system],
});
