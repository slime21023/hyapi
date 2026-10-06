/** Serves an application on a Deno listener and coordinates graceful shutdown. @module */

import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../config.ts";
import { MAX_TIMER_MS, sleep } from "../runtime/timers.ts";
import type { HyApplication } from "../types.ts";

/** Listener settings for {@link serve}. */
export interface ServeOptions {
  /** Interface to bind. Defaults to `127.0.0.1`, so nothing is exposed unless requested. */
  readonly hostname?: string;
  /** TCP port. Defaults to 8000; use 0 for an ephemeral port. */
  readonly port?: number;
  /** Starts graceful shutdown when aborted. */
  readonly signal?: AbortSignal;
  /**
   * OS signals that start graceful shutdown. None are registered unless listed. On Windows, only
   * `SIGINT` and `SIGBREAK` are supported; other listed signals are skipped there.
   */
  readonly shutdownSignals?: readonly Deno.Signal[];
  /** Called once the listener is bound. Deno's default "Listening on" message is used otherwise. */
  readonly onListen?: (addr: Deno.NetAddr) => void;
}

/** A running listener for one application. */
export interface HyServer {
  readonly addr: Deno.NetAddr;
  /** Settles after both the listener and the application have closed; rejects with their errors. */
  readonly finished: Promise<void>;
  /** Starts graceful shutdown; repeated calls return the same promise. */
  shutdown(): Promise<void>;
}

const WINDOWS_SIGNALS: ReadonlySet<Deno.Signal> = new Set(["SIGINT", "SIGBREAK"]);

/** Resolves at `deadline` (epoch ms) or when `signal` aborts, whichever comes first. */
async function waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(remaining, MAX_TIMER_MS), signal).catch(() => undefined);
  }
}

/**
 * Serves `app.fetch` with `Deno.serve` and shuts both down in order: the application stops admitting
 * requests and drains first, then the listener closes once in-flight transmissions finish.
 *
 * The listener waits up to `2 * shutdownTimeoutMs + 1000` ms for transmissions before aborting them.
 * Deno 2.9 can throw `BadResource` when a listener is aborted during `shutdown()` with an unfinished
 * stream, so the abort always happens before `shutdown()` is called.
 *
 * @example
 * ```ts
 * const server = serve(app, { port: 8000, shutdownSignals: ["SIGINT", "SIGTERM"] });
 * await server.finished;
 * ```
 */
export function serve(app: HyApplication, options: ServeOptions = {}): HyServer {
  const controller = new AbortController();
  const transmissions = new Set<Promise<void>>();
  let notifyIdle: (() => void) | undefined;
  const server = Deno.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 8000,
    signal: controller.signal,
    ...(options.onListen ? { onListen: options.onListen } : {}),
  }, (request, info) => {
    const completed = info.completed;
    transmissions.add(completed);
    const settled = () => {
      transmissions.delete(completed);
      if (transmissions.size === 0) notifyIdle?.();
    };
    void completed.then(settled, settled);
    return app.fetch(request);
  });

  const signals = (options.shutdownSignals ?? []).filter((signal) =>
    Deno.build.os !== "windows" || WINDOWS_SIGNALS.has(signal)
  );
  const onSignal = () => void shutdown().catch(() => undefined);

  let stopping: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    return stopping ??= (async () => {
      for (const signal of signals) Deno.removeSignalListener(signal, onSignal);
      options.signal?.removeEventListener("abort", onSignal);
      const closingApp = app.close();
      const deadline = Date.now() +
        2 * (app.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS) + 1_000;
      const watchdog = new AbortController();
      const closingServer = (async () => {
        if (transmissions.size > 0) {
          const idle = new Promise<void>((resolve) => {
            notifyIdle = resolve;
            if (transmissions.size === 0) resolve();
          });
          await Promise.race([idle, waitUntil(deadline, watchdog.signal)]);
        }
        if (transmissions.size > 0) controller.abort();
        await server.shutdown();
        await server.finished;
      })();
      try {
        const results = await Promise.allSettled([closingApp, closingServer]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : []
        );
        if (errors.length > 1) throw new AggregateError(errors, "Server shutdown failed.");
        if (errors.length === 1) throw errors[0];
      } finally {
        watchdog.abort();
      }
    })();
  }

  for (const signal of signals) Deno.addSignalListener(signal, onSignal);
  if (options.signal?.aborted) onSignal();
  else options.signal?.addEventListener("abort", onSignal, { once: true });

  const finished = (async () => {
    try {
      await server.finished;
    } finally {
      await shutdown();
    }
  })();

  return { addr: server.addr, finished, shutdown };
}
