import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

type CpuUsage = { user: number; system: number };
const threadCpuUsage = (process as unknown as { threadCpuUsage?: () => CpuUsage }).threadCpuUsage;

/** True when `cpuMs` is the calling thread's own CPU time (Node 22.19 and later), false when it falls back to the wall clock. */
export const cpuClockIsThreadTime = threadCpuUsage !== undefined;

/**
 * Milliseconds of CPU time the calling thread has used. A timing check that must hold "on a machine that can run the suite" reads this
 * and not `performance.now()`: time spent waiting for a core while other processes run is not a cost of the code under test, and it is
 * the whole tail on a busy host. Falls back to the wall clock on a Node without `process.threadCpuUsage`.
 */
export const cpuMs = (): number => {
  if (!threadCpuUsage) return performance.now();
  const u = threadCpuUsage.call(process);
  return (u.user + u.system) / 1000;
};

/**
 * Keeps `threads` cores busy (twice the cores by default, so the thread under test is always competing for one) until the returned
 * function is awaited. This is what a loaded NAS or a shared docker host does to a wall-clock assertion.
 */
export function saturate(threads: number = availableParallelism() * 2): () => Promise<void> {
  const workers = Array.from({ length: threads }, () => new Worker('for (;;) {}', { eval: true }));
  return async () => void (await Promise.all(workers.map((w) => w.terminate())));
}
