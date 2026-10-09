// A process for the signal-driven shutdown test: serves, prints its port, and stops on a signal.
import Type from "typebox";
import { createApp, implement } from "@hyapi/core";
import { serve } from "@hyapi/core/deno";
import { defineApi, defineContract } from "@hyapi/core/contract";

const contract = defineContract({
  operations: {
    ping: { method: "GET", path: "/ping", responses: { 200: Type.Object({ ok: Type.Boolean() }) } },
  },
});
const app = await createApp({
  api: defineApi({ info: { title: "Serve", version: "1" }, contracts: [contract] }),
  implementations: [implement(contract, { ping: () => ({ status: 200, body: { ok: true } }) })],
  lifecycle: [{ name: "resource", stop: () => console.log("resource stopped") }],
  onEvent: () => {},
});
const server = serve(app, {
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log(`ready ${port}`),
});
await server.finished;
console.log("stopped");
