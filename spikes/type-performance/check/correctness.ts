// Confirms that the prototype's types accept valid code and reject the errors RFC 0001 promises
// to catch. Every @ts-expect-error must be consumed, so `deno check` fails if a check is missing.
import {
  apiKey,
  createApp,
  defineApi,
  defineContract,
  defineResponse,
  defineSchema,
  defineSecurity,
  type Handler,
  httpBearer,
  implement,
  notImplemented,
  Problem,
  problem,
  T,
} from "../lib/hyapi.ts";

const security = defineSecurity({
  bearer: httpBearer<{ subject: string }>(),
  key: apiKey<{ client: string }>({ in: "header", name: "x-api-key" }),
});

const User = defineSchema(
  "User",
  T.Object({ id: T.String(), name: T.String(), email: T.Optional(T.String()) }),
);
const CreateUser = defineSchema("CreateUser", T.Omit(User, ["id"]));
const NotFound = defineResponse("NotFound", {
  description: "Not found",
  body: Problem,
});

const users = defineContract({
  securitySchemes: security,
  operations: {
    getUser: {
      method: "GET",
      path: "/users/{id}",
      security: [{ bearer: ["users:read"] }, { key: [] }],
      params: T.Object({ id: T.String() }),
      responses: { 200: User, 404: NotFound },
    },
    createUser: {
      method: "POST",
      path: "/users",
      security: [],
      body: CreateUser,
      responses: {
        201: {
          description: "Created",
          body: User,
          headers: T.Object({ location: T.String() }),
        },
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

// Valid handler in its own declaration.
const getUser: Handler<typeof users, "getUser"> = ({ params }, ctx) => {
  const who = "bearer" in ctx.security ? ctx.security.bearer.subject : ctx.security.key.client;
  return params.id === who
    ? { status: 200, body: { id: params.id, name: who } }
    : { status: 404, body: problem({ title: "User not found" }) };
};

export const impl = implement(users, {
  getUser,
  createUser: ({ body }, ctx) => {
    const publicSecurity: undefined = ctx.security;
    void publicSecurity;
    return {
      status: 201,
      body: { id: "1", ...body },
      headers: { location: "/users/1" },
    };
  },
  deleteUser: notImplemented,
});

const api = defineApi({
  info: { title: "Check", version: "1.0.0" },
  securitySchemes: security,
  contracts: [users],
});

export const app = createApp({
  api,
  implementations: [impl],
  verifiers: {
    bearer: () => ({ identity: { subject: "a" }, scopes: [] }),
    key: () => ({ identity: { client: "c" }, scopes: [] }),
  },
});

// --- Errors that must be caught ------------------------------------------------------------------

defineContract({
  securitySchemes: security,
  operations: {
    // @ts-expect-error path parameter {id} is not declared in params
    missingParam: {
      method: "GET",
      path: "/users/{id}",
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

implement(users, {
  // @ts-expect-error undeclared status
  getUser: () => ({ status: 201, body: { id: "1", name: "n" } }),
  createUser: notImplemented,
  deleteUser: notImplemented,
});

implement(users, {
  // @ts-expect-error body does not match the 200 schema
  getUser: () => ({ status: 200, body: { id: 1, name: "n" } }),
  createUser: notImplemented,
  deleteUser: notImplemented,
});

implement(users, {
  getUser: notImplemented,
  // @ts-expect-error declared response header `location` is missing
  createUser: () => ({ status: 201, body: { id: "1", name: "n" } }),
  deleteUser: notImplemented,
});

// @ts-expect-error handler for deleteUser is missing
implement(users, {
  getUser: notImplemented,
  createUser: notImplemented,
});

implement(users, {
  getUser: notImplemented,
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
  createUser: notImplemented,
  deleteUser: notImplemented,
});

createApp({
  api,
  implementations: [impl],
  // @ts-expect-error verifier for `key` is missing
  verifiers: { bearer: () => ({ identity: { subject: "a" }, scopes: [] }) },
});
