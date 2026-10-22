import { node } from "@elysia/node";
import { Elysia, type AnyElysia } from "elysia";
import type { ListenOptions, Listener } from "./contract.ts";

type NodeBinding = {
  raw: {
    ready(): Promise<unknown>;
    readonly url?: string | URL;
  };
  stop(): Promise<void> | void;
};

export async function createListener(app: AnyElysia, options: ListenOptions): Promise<Listener> {
  const isNode = typeof Bun === "undefined";
  const serverApp = options.fetch
    ? (isNode ? new Elysia({ adapter: node() }) : new Elysia()).mount(options.fetch)
    : app;

  // The Node adapter passes its binding only to this callback; it does not set app.server.
  const binding: { server?: AnyElysia["server"] } = {};
  serverApp.listen(
    {
      port: options.port,
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      // Elysia's Bun adapter defaults to SO_REUSEPORT, which lets a second process silently
      // share an occupied port; fail the bind instead, as Node does.
      reusePort: false,
    },
    (server) => {
      binding.server = server;
    },
  );
  const server = binding.server;
  if (!server) throw new Error("Elysia did not return a listening server.");

  let url: URL;
  if (isNode) {
    const nodeBinding = server as unknown as NodeBinding;
    try {
      // srvx starts listening asynchronously; its ready() rejects on bind errors.
      await nodeBinding.raw.ready();
      const boundUrl = nodeBinding.raw.url;
      if (!boundUrl) throw new Error("Node adapter did not report its bound URL.");
      url = new URL(boundUrl);
    } catch (error) {
      try {
        await nodeBinding.stop();
      } catch {
        // Preserve the binding failure if shutdown also fails.
      }
      throw error;
    }
  } else {
    url = new URL(server.url);
  }
  // A wildcard bind accepts loopback traffic, but its literal URL is not portable to fetch().
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  else if (url.hostname === "[::]") url.hostname = "[::1]";

  let stopping: Promise<void> | undefined;
  return {
    url,
    stop() {
      stopping ??= (async () => {
        if (isNode) await (server as unknown as NodeBinding).stop();
        else if (serverApp.server === server) await serverApp.stop();
        else await server.stop();
      })();
      return stopping;
    },
  };
}
