import type { App } from "../../mod.ts";

/** Options for {@link serve}. */
export interface ServeOptions {
  /** Defaults to 8000. */
  readonly port?: number;
  /** Defaults to Deno's own default (`0.0.0.0`). */
  readonly hostname?: string;
  /**
   * OS signals that start a graceful shutdown. Defaults to `SIGINT` and `SIGTERM`, or `SIGINT`
   * and `SIGBREAK` on Windows, where `SIGTERM` cannot be observed.
   */
  readonly signals?: readonly Deno.Signal[];
  /** Also starts a graceful shutdown when aborted. */
  readonly signal?: AbortSignal;
  /**
   * After this long, open connections are closed forcibly, even if the application has not
   * finished closing. Defaults to 30 000 ms. Keep it above the app's `shutdownTimeoutMs`.
   */
  readonly shutdownTimeoutMs?: number;
  /**
   * The handler to serve. Defaults to `app.fetch`; pass a wrapped handler to apply outer `fetch`
   * wrappers such as CORS while `serve` still closes `app` on shutdown.
   */
  readonly fetch?: (request: Request) => Response | Promise<Response>;
  /** Called when the listener is ready. Defaults to Deno's "Listening on" message. */
  readonly onListen?: (address: Deno.NetAddr) => void;
}

/** A running listener. */
export interface Server {
  readonly addr: Deno.NetAddr;
  /**
   * Resolves when the listener has stopped and the application has closed. It never rejects:
   * `shutdown()` rejects with close errors, and the application reports each failing resource as
   * a `lifecycle.error` event.
   */
  readonly finished: Promise<void>;
  /**
   * Stops accepting connections, closes the application (drain, abort, stop resources), and
   * waits for open responses, forcing them closed after `shutdownTimeoutMs`. Idempotent.
   */
  shutdown(): Promise<void>;
}

function defaultSignals(): Deno.Signal[] {
  return Deno.build.os === "windows" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
}

/**
 * Serves an application with `Deno.serve` and shuts it down gracefully on OS signals.
 *
 * Run with `--unstable-no-legacy-abort`: without it, Deno aborts every request's signal after a
 * successful response, which handlers would observe as a client disconnect.
 *
 * @example
 * ```ts
 * const server = serve(await createApp({ api, implementations }), { port: 8000 });
 * await server.finished;
 * ```
 */
export function serve(app: App, options: ServeOptions = {}): Server {
  const listener = new AbortController();
  const server = Deno.serve(
    {
      port: options.port ?? 8000,
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
      signal: listener.signal,
      ...(options.onListen === undefined ? {} : {
        onListen: (address: Deno.NetAddr) => options.onListen!(address),
      }),
    },
    options.fetch ?? ((request) => app.fetch(request)),
  );

  // Installed only after the listener started, so a failed start leaves no handlers behind.
  const signals = [...(options.signals ?? defaultSignals())];
  const onSignal = () => void shutdown().catch(() => {});
  for (const signal of signals) Deno.addSignalListener(signal, onSignal);
  options.signal?.addEventListener("abort", onSignal, { once: true });

  let stopping: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    stopping ??= (async () => {
      for (const signal of signals) Deno.removeSignalListener(signal, onSignal);
      options.signal?.removeEventListener("abort", onSignal);
      const force = setTimeout(() => listener.abort(), options.shutdownTimeoutMs ?? 30_000);
      let failure: { error: unknown } | undefined;
      try {
        await Promise.all([
          app.close().catch((error) => void (failure = { error })),
          // Stops accepting connections and waits for open responses.
          server.shutdown().catch(() => {}),
        ]);
      } finally {
        clearTimeout(force);
      }
      await server.finished;
      if (failure !== undefined) throw failure.error;
    })();
    return stopping;
  }

  const finished = (async () => {
    await server.finished;
    // Close errors belong to shutdown(); a second rejection here would go unhandled.
    if (stopping !== undefined) await stopping.catch(() => {});
  })();

  return Object.freeze({ addr: server.addr as Deno.NetAddr, finished, shutdown });
}
