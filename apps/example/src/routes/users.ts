import { defineRoute, type RouteGroupApi } from "@hyapi/core";
import {
  CreateUserSchema,
  UpdateUserSchema,
  UserIdParamsSchema,
  UserListQuerySchema,
  UserListResponseSchema,
  UserSchema,
} from "../schemas.ts";
import type { UserService } from "../services/user-service.ts";

export function registerUserRoutes(api: RouteGroupApi, service: UserService): void {
  api.group("/v1/users", { tags: ["users"] }, (users) => {
    users.group({ auth: { scopes: ["users:read"] } }, (readers) => {
      readers.route(
        defineRoute({
          method: "get",
          path: "",
          request: { query: UserListQuerySchema },
          responses: { 200: UserListResponseSchema },
          metadata: { operationId: "listUsers", summary: "List users" },
          handler: ({ query, ok }) => ok(service.list(query.offset ?? 0, query.limit ?? 20)),
        }),
      );
      readers.route(
        defineRoute({
          method: "get",
          path: "/{id}",
          request: { params: UserIdParamsSchema },
          responses: { 200: UserSchema },
          metadata: { operationId: "getUser", summary: "Get a user" },
          handler: ({ params, ok }) => ok(service.get(params.id)),
        }),
      );
    });

    users.group({ auth: { scopes: ["users:write"] } }, (writers) => {
      writers.route(
        defineRoute({
          method: "post",
          path: "",
          request: { body: CreateUserSchema },
          responses: { 201: UserSchema },
          metadata: { operationId: "createUser", summary: "Create a user" },
          handler: ({ body, created }) => created(service.create(body)),
        }),
      );
      writers.route(
        defineRoute({
          method: "patch",
          path: "/{id}",
          request: { params: UserIdParamsSchema, body: UpdateUserSchema },
          responses: { 200: UserSchema },
          metadata: { operationId: "updateUser", summary: "Update a user" },
          handler: ({ params, body, ok }) => ok(service.update(params.id, body)),
        }),
      );
      writers.route(
        defineRoute({
          method: "delete",
          path: "/{id}",
          request: { params: UserIdParamsSchema },
          responseStatus: 204,
          metadata: { operationId: "deleteUser", summary: "Delete a user" },
          handler: ({ params, noContent }) => {
            service.delete(params.id);
            return noContent();
          },
        }),
      );
    });
  });
}
