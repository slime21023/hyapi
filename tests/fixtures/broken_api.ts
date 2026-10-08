// An API with contract errors, for CLI tests.
import Type from "typebox";
import { defineApi, defineContract } from "@hyapi/core/contract";

const broken = defineContract({
  operations: {
    a: { method: "GET", path: "/a", responses: { 200: Type.String({ format: "made-up" }) } },
    b: { method: "GET", path: "/a", responses: { 200: Type.String() } },
  },
});

export const api = defineApi({ info: { title: "Broken", version: "1" }, contracts: [broken] });
