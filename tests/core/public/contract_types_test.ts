// Type-level contract tests (RFC 0001). Valid code must type-check, and every @ts-expect-error
// must be consumed by the error it names, so `deno test` fails if a promised check disappears.
import { assertEquals } from "@std/assert";
import Type from "typebox";
import { type Handler, implement, notImplemented } from "@hyapi/core";
import {
  apiKey,
  defineApi,
  defineContract,
  defineResponse,
  defineSchema,
  defineSecurity,
  httpBearer,
  type InputOf,
  Problem,
  type ResultOf,
} from "@hyapi/core/contract";

const T = Type;

const security = defineSecurity({
  bearer: httpBearer<{ subject: string }>(),
  key: apiKey<{ client: string }>({ in: "header", name: "x-api-key" }),
});

const User = defineSchema(
  "User",
  T.Object({ id: T.String(), name: T.String(), email: T.Optional(T.String()) }),
);
const CreateUser = defineSchema("CreateUser", T.Omit(User, ["id"]));
const NotFound = defineResponse("NotFound", { description: "Not found", body: Problem });

const users = defineContract({
  securitySchemes: security,
  security: [{ bearer: ["users:read"] }],
  operations: {
    getUser: {
      method: "GET",
      path: "/users/{id}",
      security: [{ bearer: ["users:read"] }, { key: [] }],
      params: T.Object({ id: T.String() }),
      responses: { 200: User, 404: NotFound },
    },
    listUsers: {
      method: "GET",
      path: "/users",
      query: T.Object({
        limit: T.Optional(T.With(T.Integer(), { default: 20 })),
        cursor: T.Optional(T.String()),
      }),
      responses: { 200: T.Array(User) },
    },
    createUser: {
      method: "POST",
      path: "/users",
      security: [],
      body: CreateUser,
      responses: {
        201: { description: "Created", body: User, headers: T.Object({ location: T.String() }) },
      },
    },
    deleteUser: {
      method: "DELETE",
      path: "/users/{id}",
      params: T.Object({ id: T.String() }),
      responses: { 204: { description: "Deleted" } },
    },
  },
});

export const api = defineApi({
  info: { title: "Types", version: "1.0.0" },
  securitySchemes: security,
  contracts: [users],
});

// --- Valid code --------------------------------------------------------------------------------

const getUser: Handler<typeof users, "getUser"> = ({ params }, ctx) => {
  const who = "bearer" in ctx.security ? ctx.security.bearer.subject : ctx.security.key.client;
  return params.id === who
    ? { status: 200, body: { id: params.id, name: who } }
    : { status: 404, body: { title: "User not found" } };
};

export const implementation = implement(users, {
  getUser,
  listUsers: ({ query }, ctx) => {
    // A parameter with a default is required; one without stays optional.
    const limit: number = query.limit;
    const cursor: string | undefined = query.cursor;
    // The contract-level default security applies.
    const subject: string = ctx.security.bearer.subject;
    return { status: 200, body: [{ id: `${limit}${cursor ?? ""}`, name: subject }] };
  },
  createUser: ({ body }, ctx) => {
    const isPublic: undefined = ctx.security;
    void isPublic;
    return { status: 201, body: { id: "1", ...body }, headers: { location: "/users/1" } };
  },
  deleteUser: notImplemented,
});

type GetUserInput = InputOf<typeof users.operations.getUser>;
type GetUserResult = ResultOf<typeof users.operations.getUser>;
type DeleteSecurity = Parameters<Handler<typeof users, "deleteUser">>[1]["security"];
export const typeChecks: [GetUserInput, GetUserResult, DeleteSecurity][] = [
  [
    { params: { id: "1" } },
    { status: 404, body: { title: "x" } },
    { bearer: { subject: "s" } },
  ],
];

// Bodies that are neither JSON nor text arrive as bytes (RFC 0001 A24).
const files = defineContract({
  operations: {
    upload: {
      method: "PUT",
      path: "/files/{name}",
      params: T.Object({ name: T.String() }),
      body: { schema: T.String({ format: "binary" }), mediaType: "application/octet-stream" },
      responses: { 204: { description: "Stored" } },
    },
    note: {
      method: "PUT",
      path: "/notes",
      body: { schema: T.String(), mediaType: "text/plain" },
      responses: { 204: { description: "Stored" } },
    },
  },
});
implement(files, {
  upload: ({ body }) => {
    const bytes: Uint8Array = body;
    void bytes;
    return { status: 204 };
  },
  note: ({ body }) => {
    const text: string = body;
    void text;
    return { status: 204 };
  },
});
type UploadBody = InputOf<typeof files.operations.upload>["body"];
// @ts-expect-error a byte body is not a string
export const notText: UploadBody = "text";

// --- Errors that must be caught ----------------------------------------------------------------

defineContract({
  operations: {
    // @ts-expect-error path parameters missing from params: id
    missingParam: { method: "GET", path: "/users/{id}", responses: { 200: User } },
  },
});

defineContract({
  operations: {
    // @ts-expect-error params not in the path: id
    extraParam: {
      method: "GET",
      path: "/users",
      params: T.Object({ id: T.String() }),
      responses: { 200: User },
    },
  },
});

defineContract({
  securitySchemes: security,
  operations: {
    unknownScheme: {
      method: "GET",
      path: "/users",
      // @ts-expect-error scheme name typo
      security: [{ beare: ["users:read"] }],
      responses: { 200: User },
    },
  },
});

defineContract({
  operations: {
    noSchemes: {
      method: "GET",
      path: "/users",
      // @ts-expect-error a contract without securitySchemes cannot name a scheme
      security: [{ bearer: [] }],
      responses: { 200: User },
    },
  },
});

implement(users, {
  // @ts-expect-error undeclared status
  getUser: () => ({ status: 201, body: { id: "1", name: "n" } }),
  listUsers: notImplemented,
  createUser: notImplemented,
  deleteUser: notImplemented,
});

implement(users, {
  // @ts-expect-error body does not match the 200 schema
  getUser: () => ({ status: 200, body: { id: 1, name: "n" } }),
  listUsers: notImplemented,
  createUser: notImplemented,
  deleteUser: notImplemented,
});

implement(users, {
  getUser: notImplemented,
  listUsers: notImplemented,
  // @ts-expect-error declared response header `location` is missing
  createUser: () => ({ status: 201, body: { id: "1", name: "n" } }),
  deleteUser: notImplemented,
});

// @ts-expect-error handler for deleteUser is missing
implement(users, {
  getUser: notImplemented,
  listUsers: notImplemented,
  createUser: notImplemented,
});

implement(users, {
  getUser: notImplemented,
  listUsers: notImplemented,
  createUser: notImplemented,
  deleteUser: notImplemented,
  // @ts-expect-error extra handler for an undeclared operation
  removeUser: notImplemented,
});

implement(users, {
  getUser: ({ params }) => {
    // @ts-expect-error params.id is a string, not a number
    const id: number = params.id;
    return { status: 200, body: { id: String(id), name: "n" } };
  },
  listUsers: notImplemented,
  createUser: notImplemented,
  deleteUser: notImplemented,
});

implement(users, {
  getUser: notImplemented,
  listUsers: ({ query }) => {
    // @ts-expect-error cursor has no default, so it stays optional
    const cursor: string = query.cursor;
    return { status: 200, body: [{ id: cursor, name: "n" }] };
  },
  createUser: notImplemented,
  deleteUser: notImplemented,
});

implement(users, {
  getUser: (_input, ctx) => {
    // @ts-expect-error getUser accepts bearer OR key, so bearer may be absent
    const subject: string = ctx.security.bearer.subject;
    return { status: 200, body: { id: subject, name: "n" } };
  },
  listUsers: notImplemented,
  createUser: notImplemented,
  deleteUser: notImplemented,
});

Deno.test("contract types compile and catch the errors RFC 0001 promises", () => {
  assertEquals(implementation.kind, "hyapi.implementation");
  assertEquals(Object.keys(implementation.handlers), [
    "getUser",
    "listUsers",
    "createUser",
    "deleteUser",
  ]);
});
