import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * Times a section that does the same work every run (a seeded rebuild, a scripted camera path) and returns one time per step. A quiet
 * host passes on the first run and nothing else happens. When `ok` refuses the profile, the section is run again, up to `maxRuns`,
 * and each step keeps the smallest time seen in any run: work is the same each run, so the smallest is the work and the rest is the
 * host (a preemption lands on a different step each time). Code that really costs more than the budget costs it in every run, so it
 * still fails. The thread's own CPU time (`process.threadCpuUsage`) is no help: some kernels account it in 4 ms ticks (measured on
 * the docker host).
 */
export async function quietest(run: () => number[] | Promise<number[]>, ok: (profile: number[]) => boolean, maxRuns = 5): Promise<{ profile: number[]; runs: number }> {
  let profile = await run();
  let runs = 1;
  while (!ok(profile) && runs < maxRuns) {
    const again = await run();
    profile = profile.map((t, i) => Math.min(t, again[i] ?? t));
    runs++;
  }
  return { profile, runs };
}

/**
 * Keeps `threads` cores busy (twice the cores by default, so the thread under test is always competing for one) until the returned
 * function is awaited. This is what a loaded NAS or a shared docker host does to a wall-clock assertion.
 */
export function saturate(threads: number = availableParallelism() * 2): () => Promise<void> {
  const workers = Array.from({ length: threads }, () => new Worker('for (;;) {}', { eval: true }));
  return async () => void (await Promise.all(workers.map((w) => w.terminate())));
}
