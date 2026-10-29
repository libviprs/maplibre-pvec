import { PVecAbortError } from "./errors";

export interface Waste {
  /** Bytes fetched and then thrown away. */
  bytes: number;
  /** Milliseconds of decode or tessellation spent on a discarded generation. */
  decodeMs: number;
  abortedRequests: number;
}

export type JobOutcome = "done" | "aborted" | "stale";

interface Job {
  controller: AbortController;
  generation: number;
}

/**
 * Tracks obsolete work. Each job gets an AbortController and the generation that was current when
 * it started. Superseding a job aborts it; bumping the generation makes every older result stale.
 * Aborts are a normal outcome here and never surface as an error.
 */
export class JobTracker {
  generation = 0;
  readonly waste: Waste = { bytes: 0, decodeMs: 0, abortedRequests: 0 };
  private jobs = new Map<string, Job>();

  bumpGeneration(): number {
    return ++this.generation;
  }

  /** The single stale-generation gate. */
  accept(generation: number): boolean {
    return generation === this.generation;
  }

  recordDecode(ms: number, discarded: boolean): void {
    if (discarded) this.waste.decodeMs += ms;
  }

  /** Abort every job whose key is not in `keep`. */
  supersede(keep: ReadonlySet<string>): void {
    for (const [key, job] of this.jobs) if (!keep.has(key)) job.controller.abort();
  }

  async run(
    key: string,
    work: (signal: AbortSignal) => Promise<Uint8Array>,
    onResult: (bytes: Uint8Array) => void,
  ): Promise<JobOutcome> {
    this.jobs.get(key)?.controller.abort();
    const job: Job = { controller: new AbortController(), generation: this.generation };
    this.jobs.set(key, job);
    try {
      const bytes = await work(job.controller.signal);
      if (job.controller.signal.aborted) {
        this.waste.bytes += bytes.byteLength;
        this.waste.abortedRequests++;
        return "aborted";
      }
      if (!this.accept(job.generation)) {
        this.waste.bytes += bytes.byteLength;
        return "stale";
      }
      onResult(bytes);
      return "done";
    } catch (e) {
      if (e instanceof PVecAbortError || job.controller.signal.aborted) {
        this.waste.abortedRequests++;
        return "aborted";
      }
      throw e;
    } finally {
      if (this.jobs.get(key) === job) this.jobs.delete(key);
    }
  }
}
