import { POOL_DEFAULTS, QUEUE_DEFAULTS } from '../config/defaults';
import type { JobTag } from '../refine/generation';
import type { CurveFamily } from './evaluator';
import type { WorkerIn, WorkerLike, WorkerOut } from './runtime';

/** Worker count default: clamp(hardwareConcurrency - 1, 1, 4). */
export function defaultWorkerCount(hardwareConcurrency: number): number {
  return Math.min(POOL_DEFAULTS.maxWorkers, Math.max(POOL_DEFAULTS.minWorkers, hardwareConcurrency - 1));
}

/** Returns transferred ArrayBuffers to the sender for reuse, keyed by size. */
export class BufferRecycler {
  private free = new Map<number, ArrayBuffer[]>();
  pooledBuffers = 0;
  acquire(bytes: number): ArrayBuffer {
    const list = this.free.get(bytes);
    const b = list?.pop();
    if (b) { this.pooledBuffers--; return b; }
    return new ArrayBuffer(bytes);
  }
  release(b: ArrayBuffer): void {
    if (b.byteLength === 0) return;
    const list = this.free.get(b.byteLength) ?? [];
    if (list.length >= 32) return;
    list.push(b);
    this.free.set(b.byteLength, list);
    this.pooledBuffers++;
  }
}

export interface PoolJob {
  family: CurveFamily;
  control: Float64Array;
  t0: number;
  t1: number;
  chordUnits: number;
  tag: JobTag;
}

export type JobResult =
  | { status: 'done'; tag: JobTag; params: Float64Array; positions: Float64Array; evaluations: number; durationMs: number }
  | { status: 'cancelled'; tag: JobTag; evaluations: number }
  | { status: 'error'; tag: JobTag; message: string };

export interface PoolOptions {
  spawn: () => WorkerLike;
  size?: number;
  now?: () => number;
  /** Opt in to the shared-memory output path. Honoured only when `isolated` is true. */
  sharedMemory?: boolean;
  /** Defaults to globalThis.crossOriginIsolated === true. */
  isolated?: boolean;
  perWorkerInFlight?: number;
  perWorkerBytes?: number;
  maxInFlight?: number;
}

interface Slot {
  worker: WorkerLike;
  inFlight: number;
  bytes: number;
  busyMs: number;
  busySince: number;
}

interface Pending {
  slot: Slot;
  tag: JobTag;
  bytes: number;
  startedAt: number;
  resolve: (r: JobResult) => void;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

/**
 * Transferable-by-default worker pool. Control data goes out and tessellation comes back in the
 * transfer list; SharedArrayBuffer is an opt-in that is never required.
 */
export class WorkerPool {
  readonly size: number;
  readonly recycler = new BufferRecycler();
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly now: () => number;
  private readonly perWorkerInFlight: number;
  private readonly perWorkerBytes: number;
  private readonly maxInFlight: number;
  private readonly shared: boolean;
  /** Called synchronously after every job settles, so a caller can refill the pool without waiting for a frame. */
  onSettled: (() => void) | null = null;
  private nextId = 1;
  private firstDispatch = -1;
  private inFlightNow = 0;
  private s = { dispatched: 0, maxInFlight: 0, maxWorkerBytes: 0, copiesDetected: 0, detachChecks: 0 };
  private durations: number[] = [];

  constructor(o: PoolOptions) {
    this.size = o.size ?? defaultWorkerCount(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4);
    this.now = o.now ?? (() => performance.now());
    this.perWorkerInFlight = o.perWorkerInFlight ?? QUEUE_DEFAULTS.perWorkerInFlight;
    this.perWorkerBytes = o.perWorkerBytes ?? QUEUE_DEFAULTS.perWorkerBytes;
    this.maxInFlight = Math.min(o.maxInFlight ?? QUEUE_DEFAULTS.maxInFlight, this.size * this.perWorkerInFlight);
    this.shared = o.sharedMemory === true && (o.isolated ?? (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true);
    for (let i = 0; i < this.size; i++) {
      const worker = o.spawn();
      const slot: Slot = { worker, inFlight: 0, bytes: 0, busyMs: 0, busySince: 0 };
      worker.onmessage = (e) => this.onMessage(slot, e.data);
      this.slots.push(slot);
    }
  }

  /** Post the one compiled module to every worker. Memory is not shared. */
  init(module?: WebAssembly.Module): void {
    for (const s of this.slots) s.worker.postMessage({ type: 'init', module, shared: this.shared } satisfies WorkerIn);
  }

  /**
   * Start a job on the least loaded worker, or return null when the in-flight or per-worker byte
   * budget has no room. The job's control buffer is detached in this thread.
   */
  tryRun(job: PoolJob, signal?: AbortSignal): Promise<JobResult> | null {
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled', tag: job.tag, evaluations: 0 });
    if (this.inFlightNow >= this.maxInFlight) return null;
    const bytes = job.control.byteLength;
    let best: Slot | undefined;
    for (const s of this.slots) {
      if (s.inFlight >= this.perWorkerInFlight) continue;
      if (s.inFlight > 0 && s.bytes + bytes > this.perWorkerBytes) continue;
      if (!best || s.inFlight < best.inFlight || (s.inFlight === best.inFlight && s.bytes < best.bytes)) best = s;
    }
    if (!best) return null;
    const slot = best;
    const jobId = this.nextId++;
    const t = this.now();
    if (this.firstDispatch < 0) this.firstDispatch = t;
    if (slot.inFlight === 0) slot.busySince = t;
    slot.inFlight++; slot.bytes += bytes; this.inFlightNow++;
    this.s.dispatched++;
    this.s.maxInFlight = Math.max(this.s.maxInFlight, this.inFlightNow);
    this.s.maxWorkerBytes = Math.max(this.s.maxWorkerBytes, slot.bytes);
    return new Promise<JobResult>((resolve) => {
      const p: Pending = { slot, tag: job.tag, bytes, startedAt: t, resolve, signal };
      this.pending.set(jobId, p);
      if (signal) {
        p.onAbort = () => slot.worker.postMessage({ type: 'cancel', jobId });
        signal.addEventListener('abort', p.onAbort, { once: true });
      }
      const buf = job.control.buffer as ArrayBuffer;
      slot.worker.postMessage({ type: 'job', jobId, family: job.family, control: job.control, t0: job.t0, t1: job.t1, chordUnits: job.chordUnits, tag: job.tag }, [buf]);
      this.s.detachChecks++;
      if (buf.byteLength !== 0) this.s.copiesDetected++; // the post copied instead of transferring
    });
  }

  private onMessage(slot: Slot, m: WorkerOut): void {
    const p = this.pending.get(m.jobId);
    if (!p) return;
    this.pending.delete(m.jobId);
    if (p.onAbort) p.signal?.removeEventListener('abort', p.onAbort);
    const t = this.now();
    slot.inFlight--; slot.bytes -= p.bytes; this.inFlightNow--;
    if (slot.inFlight === 0) slot.busyMs += t - slot.busySince;
    this.recycler.release(m.control.buffer as ArrayBuffer);
    if (m.type === 'done') {
      this.s.detachChecks++;
      const durationMs = t - p.startedAt;
      this.durations.push(durationMs);
      if (this.durations.length > 8192) this.durations.splice(0, 4096); // keep the recent window, not every job ever
      p.resolve({ status: 'done', tag: p.tag, params: m.params, positions: m.positions, evaluations: m.evaluations, durationMs });
    } else if (m.type === 'cancelled') p.resolve({ status: 'cancelled', tag: p.tag, evaluations: m.evaluations });
    else p.resolve({ status: 'error', tag: p.tag, message: m.message });
    this.onSettled?.();
  }

  get inFlight(): number { return this.inFlightNow; }

  /** Fraction of worker-time spent with at least one job, from the first dispatch until now. */
  utilisation(): number {
    if (this.firstDispatch < 0) return 0;
    const t = this.now();
    const window = t - this.firstDispatch;
    if (window <= 0) return 0;
    let busy = 0;
    for (const s of this.slots) busy += s.busyMs + (s.inFlight > 0 ? t - s.busySince : 0);
    return busy / (this.size * window);
  }

  /** Total worker-time with at least one job in flight, ms (open intervals included). */
  busyMs(): number {
    const t = this.now();
    let busy = 0;
    for (const s of this.slots) busy += s.busyMs + (s.inFlight > 0 ? t - s.busySince : 0);
    return busy;
  }

  stats() {
    const d = [...this.durations].sort((a, b) => a - b);
    return {
      ...this.s,
      sharedPath: this.shared,
      p99DurationMs: d.length ? d[Math.min(d.length - 1, Math.floor(d.length * 0.99))]! : 0,
    };
  }

  terminate(): void {
    for (const s of this.slots) s.worker.terminate();
  }
}
