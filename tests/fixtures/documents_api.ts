// APIs for the several-documents tests: a public subset of the library API, and an API whose
// `listBooks` names a different route.
import Type from "typebox";
import { defineApi, defineContract } from "@hyapi/core/contract";
import { api, books, security } from "./library_api.ts";

export const publicApi = defineApi({
  info: { ...api.info, title: "Library API (public)" },
  securitySchemes: security,
  security: [{ key: [] }],
  contracts: [books],
});

export const conflictingApi = defineApi({
  info: { title: "Conflicting", version: "1" },
  contracts: [
    defineContract({
      operations: {
        listBooks: {
          method: "GET",
          path: "/catalog",
          responses: { 200: Type.Object({ ok: Type.Boolean() }) },
        },
      },
    }),
  ],
});
