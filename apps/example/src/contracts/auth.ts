import { definePort, type Guard } from "@hyapi/core";

/** The application's authentication guard, provided once and used by every protected module. */
export const authPort = definePort<Guard>("platform.auth");
