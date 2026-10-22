import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {once} from 'node:events';

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // An exited root no longer identifies its tree; its PID may already have been reused.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Cannot confirm process-tree cleanup after root ${child.pid} exited.`,
      );
    }
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    const [code] = await once(killer, 'close');
    if (code !== 0) {
      throw new Error(
        `Could not terminate process tree ${child.pid} (${code}).`,
      );
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

export async function runProcess(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<void> {
  const child = spawn(command, arguments_, {
    cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  const completion = once(child, 'close') as Promise<
    [number | null, NodeJS.Signals | null]
  >;
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () =>
      deadline.reject(
        new Error(`Timed out: ${command} ${arguments_.join(' ')}`),
      ),
    timeoutMs,
  );
  try {
    const [code, signal] = await Promise.race([completion, deadline.promise]);
    if (code !== 0) {
      throw new Error(
        `${command} ${arguments_.join(' ')} failed (${code ?? signal}).`,
      );
    }
  } catch (error) {
    if (closed) throw error;
    let cleanupErrors: [unknown, unknown] | undefined;
    try {
      await terminate(child);
      await completion.catch(() => undefined);
    } catch (cleanupError) {
      if (!closed) cleanupErrors = [error, cleanupError];
    }
    if (cleanupErrors) {
      throw new AggregateError(cleanupErrors, 'Process cleanup failed.', {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
