import { defineRoute, type RouteGroupApi, type ServiceReference } from "@hyapi/core";
import {
  CreateUserSchema,
  UpdateUserSchema,
  UserIdParamsSchema,
  UserListQuerySchema,
  UserListResponseSchema,
  UserSchema,
} from "./users.schemas.ts";
import type { UserService } from "./user-service.ts";

export function registerUserRoutes(
  api: RouteGroupApi,
  service: ServiceReference<UserService>,
): void {
  api.group("/v1/users", { tags: ["users"] }, (users) => {
    users.group({ auth: { scopes: ["users:read"] } }, (readers) => {
      readers.route(
        defineRoute({
          method: "get",
          path: "",
          request: { query: UserListQuerySchema },
          responses: { 200: UserListResponseSchema },
          metadata: { operationId: "listUsers", summary: "List users" },
          handler: async ({ query, ok, services }) =>
            ok((await services.get(service)).list(query.offset ?? 0, query.limit ?? 20)),
        }),
      );
      readers.route(
        defineRoute({
          method: "get",
          path: "/{id}",
          request: { params: UserIdParamsSchema },
          responses: { 200: UserSchema },
          metadata: { operationId: "getUser", summary: "Get a user" },
          handler: async ({ params, ok, services }) =>
            ok((await services.get(service)).get(params.id)),
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
          handler: async ({ body, created, services }) =>
            created((await services.get(service)).create(body)),
        }),
      );
      writers.route(
        defineRoute({
          method: "patch",
          path: "/{id}",
          request: { params: UserIdParamsSchema, body: UpdateUserSchema },
          responses: { 200: UserSchema },
          metadata: { operationId: "updateUser", summary: "Update a user" },
          handler: async ({ params, body, ok, services }) =>
            ok((await services.get(service)).update(params.id, body)),
        }),
      );
      writers.route(
        defineRoute({
          method: "delete",
          path: "/{id}",
          request: { params: UserIdParamsSchema },
          responseStatus: 204,
          metadata: { operationId: "deleteUser", summary: "Delete a user" },
          handler: async ({ params, noContent, services }) => {
            (await services.get(service)).delete(params.id);
            return noContent();
          },
        }),
      );
    });
  });
}
