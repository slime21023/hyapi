import { definePort } from "@hyapi/core";

export interface UserDirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface UserDirectory {
  find(id: string): Promise<UserDirectoryEntry | null>;
}

export const userDirectoryPort = definePort<UserDirectory>("users.directory");
