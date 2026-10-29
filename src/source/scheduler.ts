import { PVecAbortError, PVecBackpressureError } from "./errors";
import { MAX_MERGED_BYTES, OverfetchLedger, shouldMerge } from "./coalesce";
import type { PVecBounds, PVecChunk, PVecSource } from "./PVecSource";

/**
 * 1 visible Tier 0, 2 visible deferred, 3 near-visible Tier 0, 5 prefetch. Class 4 is not a
 * request class: it is the rank a near-visible request drops to while the camera moves.
 */
export type PriorityClass = 1 | 2 | 3 | 5;

export interface RangeRequest {
  offset: number;
  length: number;
  priority: PriorityClass;
  /** Share of the screen the chunk covers, larger first inside a class. */
  coverage?: number;
  /** Chunk order, smaller first on a coverage tie. Defaults to the file offset. */
  chunkOrder?: number;
  signal?: AbortSignal;
}

export interface ManualTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}
const realTimers: ManualTimers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
};

interface Item {
  req: RangeRequest;
  seq: number;
  resolve(b: Uint8Array): void;
  reject(e: unknown): void;
  onAbort?: () => void;
}

/** PROVISIONAL (M8.6): how long after a gesture ends prefetch stays quiet. */
const DEFAULT_IDLE_MS = 150;

export class RangeScheduler {
  readonly overfetch = new OverfetchLedger();
  readonly stats = { peakQueuedBytes: 0 };
  private queue: Item[] = [];
  private parked: { item: Item; admit: () => void }[] = [];
  private inflight = new Set<AbortController>();
  private queuedBytes = 0; // queued plus in flight
  private seq = 0;
  private interacting = false;
  private idleUntil = 0;
  private pumpScheduled = false;
  private idleTimer: number | undefined;
  private readonly coalesce: boolean;
  private readonly idleMs: number;
  private readonly timers: ManualTimers;

  constructor(
    private source: PVecSource,
    opts: { coalesce?: boolean; idleMs?: number; timers?: ManualTimers } = {},
  ) {
    this.coalesce = opts.coalesce ?? true;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.timers = opts.timers ?? realTimers;
    source.onBeforeInvalidate(() => this.abortAll());
  }

  /** Chunks come from source-space bounds only: the same bounds give the same chunks at any zoom. */
  requestViewport(bounds: PVecBounds, priority: PriorityClass): { chunk: PVecChunk; promise: Promise<Uint8Array> }[] {
    return this.source.queryBounds(bounds).map((chunk) => ({
      chunk,
      promise: this.submit({ offset: chunk.offset, length: chunk.length, priority, chunkOrder: chunk.index }),
    }));
  }

  setInteracting(on: boolean): void {
    this.interacting = on;
    if (on) {
      this.idleUntil = Infinity;
      return;
    }
    this.idleUntil = this.timers.now() + this.idleMs;
    if (this.idleTimer !== undefined) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(() => this.pump(), this.idleMs);
  }

  /** Admission is bounded: past the caps the request is refused, or parked with `wait`. */
  submit(req: RangeRequest, opts: { wait?: boolean } = {}): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const item: Item = { req, seq: this.seq++, resolve, reject };
      if (req.signal?.aborted) return reject(new PVecAbortError());
      const refusal = this.refusal(req.length);
      if (refusal) {
        if (!opts.wait) return reject(refusal);
        this.parked.push({ item, admit: () => this.admit(item) });
        return;
      }
      this.admit(item);
    });
  }

  abortAll(): void {
    for (const it of this.queue.splice(0)) {
      this.queuedBytes -= it.req.length;
      it.reject(new PVecAbortError());
    }
    for (const p of this.parked.splice(0)) p.item.reject(new PVecAbortError());
    for (const c of this.inflight) c.abort();
  }

  private refusal(length: number): PVecBackpressureError | undefined {
    const { maxQueuedBytes, maxQueuedJobs } = this.source.options.limits;
    if (this.queuedBytes + length > maxQueuedBytes) return new PVecBackpressureError(this.queuedBytes, maxQueuedBytes, "queued bytes");
    if (this.queue.length >= maxQueuedJobs) return new PVecBackpressureError(this.queue.length, maxQueuedJobs, "queued jobs");
    return undefined;
  }

  private admit(item: Item): void {
    this.queue.push(item);
    this.queuedBytes += item.req.length;
    this.stats.peakQueuedBytes = Math.max(this.stats.peakQueuedBytes, this.queuedBytes);
    const sig = item.req.signal;
    if (sig) {
      item.onAbort = () => {
        const i = this.queue.indexOf(item);
        if (i < 0) return; // in flight: the fetch abort carries it
        this.queue.splice(i, 1);
        this.queuedBytes -= item.req.length;
        item.reject(new PVecAbortError());
        this.drainParked();
      };
      sig.addEventListener("abort", item.onAbort, { once: true });
    }
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private rank(it: Item): number {
    return it.req.priority === 3 && this.interacting ? 4 : it.req.priority;
  }
  private prefetchBlocked(): boolean {
    return this.interacting || this.timers.now() < this.idleUntil;
  }
  private order = (a: Item, b: Item): number =>
    this.rank(a) - this.rank(b) ||
    (b.req.coverage ?? 0) - (a.req.coverage ?? 0) ||
    (a.req.chunkOrder ?? a.req.offset) - (b.req.chunkOrder ?? b.req.offset) ||
    a.seq - b.seq;

  private pump(): void {
    const max = this.source.options.limits.maxConcurrentRequests;
    while (this.inflight.size < max) {
      const blocked = this.prefetchBlocked();
      const ready = this.queue.filter((i) => !(blocked && i.req.priority === 5)).sort(this.order);
      const head = ready[0];
      if (!head) return;
      this.dispatch(head, blocked);
    }
  }

  private dispatch(head: Item, blocked: boolean): void {
    let group = [head];
    if (this.coalesce) group = this.growGroup(head, blocked);
    for (const g of group) this.queue.splice(this.queue.indexOf(g), 1);
    const offset = Math.min(...group.map((g) => g.req.offset));
    const end = Math.max(...group.map((g) => g.req.offset + g.req.length));
    const controller = new AbortController();
    this.inflight.add(controller);
    // A merged fetch is abandoned only when every member has been.
    const signals = group.map((g) => g.req.signal);
    const watch = (): void => {
      if (signals.every((s) => s?.aborted)) controller.abort();
    };
    for (const s of signals) s?.addEventListener("abort", watch, { once: true });
    watch();
    const members = [...group].sort(this.order);
    void this.source
      .readRange(offset, end - offset, { signal: controller.signal })
      .then(
        (bytes) => {
          this.overfetch.add({ requestedBytes: end - offset, usedBytes: unionBytes(group.map((g) => g.req)) });
          for (const m of members) {
            if (m.req.signal?.aborted) m.reject(new PVecAbortError());
            else m.resolve(bytes.subarray(m.req.offset - offset, m.req.offset - offset + m.req.length));
          }
        },
        (e: unknown) => {
          for (const m of members) m.reject(m.req.signal?.aborted ? new PVecAbortError() : e);
        },
      )
      .finally(() => {
        this.inflight.delete(controller);
        for (const g of group) {
          this.queuedBytes -= g.req.length;
          if (g.onAbort) g.req.signal?.removeEventListener("abort", g.onAbort);
        }
        if (this.queuedBytes < 0) this.queuedBytes = 0;
        this.drainParked();
        this.pump();
      });
  }

  /** Extend the head with queued neighbours while the guard says the merge pays. */
  private growGroup(head: Item, blocked: boolean): Item[] {
    const { rttMs, bandwidthBytesPerMs } = this.source.estimator;
    const cls = head.req.priority; // the head is the most urgent member, so it bears the delay
    const others = this.queue
      .filter((i) => i !== head && !(blocked && i.req.priority === 5))
      .sort((a, b) => a.req.offset - b.req.offset);
    const group = [head];
    let lo = head.req.offset;
    let hi = head.req.offset + head.req.length;
    for (let grew = true; grew; ) {
      grew = false;
      for (const o of others) {
        if (group.includes(o)) continue;
        const oEnd = o.req.offset + o.req.length;
        const gap = Math.max(0, o.req.offset - hi, lo - oEnd);
        const span = Math.max(hi, oEnd) - Math.min(lo, o.req.offset);
        if (span > MAX_MERGED_BYTES || !shouldMerge(gap, rttMs, bandwidthBytesPerMs, cls)) continue;
        group.push(o);
        lo = Math.min(lo, o.req.offset);
        hi = Math.max(hi, oEnd);
        grew = true;
      }
    }
    return group;
  }

  private drainParked(): void {
    while (this.parked.length) {
      const p = this.parked[0]!;
      if (this.refusal(p.item.req.length)) return;
      this.parked.shift();
      p.admit();
    }
  }
}

function unionBytes(reqs: { offset: number; length: number }[]): number {
  const sorted = [...reqs].sort((a, b) => a.offset - b.offset);
  let total = 0;
  let end = -Infinity;
  for (const r of sorted) {
    const s = Math.max(r.offset, end);
    const e = r.offset + r.length;
    if (e > s) total += e - s;
    end = Math.max(end, e);
  }
  return total;
}
