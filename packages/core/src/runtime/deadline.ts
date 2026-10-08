type Awaitable<T> = T | Promise<T>;

/**
 * Runs `work` with a signal that aborts after `timeoutMs`, and rejects with that abort reason if
 * the work has not settled by then. The timer is cleared as soon as the work settles, and no
 * promise is left pending to reject later.
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Awaitable<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`timed out after ${timeoutMs} ms`, "TimeoutError")),
    Math.max(0, timeoutMs),
  );
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        })
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
