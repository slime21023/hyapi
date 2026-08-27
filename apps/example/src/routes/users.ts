import { defineRoute } from "@hyapi/core";
import {
  CreateUserSchema,
  UpdateUserSchema,
  UserIdParamsSchema,
  UserListQuerySchema,
  UserListResponseSchema,
  UserSchema,
} from "../schemas.ts";
import type { UserService } from "../services/user-service.ts";

export function userRoutes(service: UserService) {
  return [
    defineRoute({
      method: "get",
      path: "/v1/users",
      request: { query: UserListQuerySchema },
      response: UserListResponseSchema,
      auth: { scopes: ["users:read"] },
      metadata: { operationId: "listUsers", summary: "List users", tags: ["users"] },
      handler: ({ query }) => service.list(query.offset ?? 0, query.limit ?? 20),
    }),
    defineRoute({
      method: "get",
      path: "/v1/users/{id}",
      request: { params: UserIdParamsSchema },
      response: UserSchema,
      auth: { scopes: ["users:read"] },
      metadata: { operationId: "getUser", summary: "Get a user", tags: ["users"] },
      handler: ({ params }) => service.get(params.id),
    }),
    defineRoute({
      method: "post",
      path: "/v1/users",
      request: { body: CreateUserSchema },
      response: UserSchema,
      responseStatus: 201,
      auth: { scopes: ["users:write"] },
      metadata: { operationId: "createUser", summary: "Create a user", tags: ["users"] },
      handler: ({ body }) => service.create(body),
    }),
    defineRoute({
      method: "patch",
      path: "/v1/users/{id}",
      request: { params: UserIdParamsSchema, body: UpdateUserSchema },
      response: UserSchema,
      auth: { scopes: ["users:write"] },
      metadata: { operationId: "updateUser", summary: "Update a user", tags: ["users"] },
      handler: ({ params, body }) => service.update(params.id, body),
    }),
    defineRoute({
      method: "delete",
      path: "/v1/users/{id}",
      request: { params: UserIdParamsSchema },
      responseStatus: 204,
      auth: { scopes: ["users:write"] },
      metadata: { operationId: "deleteUser", summary: "Delete a user", tags: ["users"] },
      handler: ({ params, noContent }) => {
        service.delete(params.id);
        return noContent();
      },
    }),
  ];
}
