import { withDeadline } from "./deadline.ts";
import type { Emit } from "./events.ts";
import { describeError } from "./problem.ts";

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

/** Stops resources in reverse order within a time budget; returns every failure. */
export async function stopResources(
  resources: readonly LifecycleResource[],
  timeoutMs: number,
  emit: Emit,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  // One budget for all resources; a slow resource leaves less time for the ones before it.
  const deadline = performance.now() + timeoutMs;
  for (const resource of [...resources].reverse()) {
    const stop = resource.stop;
    if (stop === undefined) continue;
    try {
      await withDeadline(stop, deadline - performance.now());
    } catch (error) {
      errors.push(error);
      emit({
        type: "lifecycle.error",
        name: resource.name,
        phase: "stop",
        error: describeError(error),
      });
    }
  }
  return errors;
}

/**
 * Starts resources in order. If one fails, the started ones are stopped in reverse order and the
 * original error is thrown; rollback failures are added in an `AggregateError`.
 */
export async function startResources(
  resources: readonly LifecycleResource[],
  timeoutMs: number,
  emit: Emit,
): Promise<void> {
  const started: LifecycleResource[] = [];
  for (const resource of resources) {
    try {
      await resource.start?.();
      started.push(resource);
    } catch (error) {
      emit({
        type: "lifecycle.error",
        name: resource.name,
        phase: "start",
        error: describeError(error),
      });
      const rollback = await stopResources(started, timeoutMs, emit);
      if (rollback.length === 0) throw error;
      throw new AggregateError([error, ...rollback], `'${resource.name}' failed to start`, {
        cause: error,
      });
    }
  }
}
