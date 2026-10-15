import type { ChildProcess } from 'node:child_process';

/** Controlled inference owns its process group and waits for close before release. */
export function linkCliCancellation(proc: ChildProcess, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  const stop = () => {
    if (proc.pid && process.platform !== 'win32') {
      try { process.kill(-proc.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    } else if (proc.exitCode === null || proc.exitCode === undefined) proc.kill('SIGKILL');
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return () => signal.removeEventListener('abort', stop);
}
