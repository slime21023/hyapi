import { withDeadline } from "./deadline.ts";

type Awaitable<T> = T | Promise<T>;

/** A resource the application starts before serving and stops when it closes. */
export interface LifecycleResource {
  /** Names the resource in errors and events. */
  readonly name: string;
  /** Called in declaration order before the application is returned. */
  readonly start?: () => Awaitable<void>;
  /** Called in reverse order on close, or to roll back a failed startup. Bounded by a signal. */
  readonly stop?: (signal: AbortSignal) => Awaitable<void>;
}

/** A resource that failed to start or stop. */
export interface LifecycleFailure {
  readonly name: string;
  readonly phase: "start" | "stop";
  readonly error: unknown;
}

/** Stops resources in reverse order within one time budget; returns every failure. */
export async function stopResources(
  resources: readonly LifecycleResource[],
  timeoutMs: number,
): Promise<LifecycleFailure[]> {
  const failures: LifecycleFailure[] = [];
  // One budget for all resources; a slow resource leaves less time for the ones before it.
  const deadline = performance.now() + timeoutMs;
  for (const resource of [...resources].reverse()) {
    const stop = resource.stop;
    if (stop === undefined) continue;
    try {
      await withDeadline(stop, deadline - performance.now());
    } catch (error) {
      failures.push({ name: resource.name, phase: "stop", error });
    }
  }
  return failures;
}

/**
 * Starts resources in order. If one fails, the started ones are stopped in reverse order. Returns
 * no failures when every resource started; otherwise the start failure, then any rollback failures.
 */
export async function startResources(
  resources: readonly LifecycleResource[],
  timeoutMs: number,
): Promise<LifecycleFailure[]> {
  const started: LifecycleResource[] = [];
  for (const resource of resources) {
    try {
      await resource.start?.();
      started.push(resource);
    } catch (error) {
      const rollback = await stopResources(started, timeoutMs);
      return [{ name: resource.name, phase: "start", error }, ...rollback];
    }
  }
  return [];
}
