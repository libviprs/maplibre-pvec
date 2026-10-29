import { QUEUE_DEFAULTS } from '../config/defaults';

export interface Candidate {
  entityId: number;
  generation: number;
  transformEpoch: number;
  /** Conservative visibility (M4.7). An off-screen entity is never queued. */
  visible: boolean;
  /** Projected screen area, device px squared. */
  areaPx: number;
  /** Evaluated error, device px. */
  errorPx: number;
  targetPx: number;
  /** Estimated work, ms (estimateCostMs). */
  costMs: number;
  navigating: boolean;
}

export interface CostInput {
  degree: number;
  ctrlCount: number;
  knotMultiplicity: number;
  trimIntervals: number;
  errorPx: number;
  targetPx: number;
}

/**
 * Estimated worker time for one tessellation, ms. Provisional: the per-unit constant is a
 * placeholder until M1.3 can be measured on the real evaluator (docs/deferred.md).
 */
export function estimateCostMs(c: CostInput): number {
  const segments = 16 * Math.max(1, Math.sqrt(c.errorPx / c.targetPx));
  const units = c.degree * c.ctrlCount * (1 + 0.5 * (c.knotMultiplicity - 1)) * (1 + 0.25 * c.trimIntervals) * segments;
  return (units * QUEUE_DEFAULTS.nsPerCostUnit) / 1e6;
}

/** Split a parameter range into pieces of about jobTargetMs of estimated work. Adjacent pieces share their endpoint exactly. */
export function planPieces(t0: number, t1: number, costMs: number, targetMs: number = QUEUE_DEFAULTS.jobTargetMs): [number, number][] {
  const n = Math.max(1, Math.ceil(costMs / targetMs));
  return Array.from({ length: n }, (_, i) => [i === 0 ? t0 : t0 + ((t1 - t0) * i) / n, i === n - 1 ? t1 : t0 + ((t1 - t0) * (i + 1)) / n]);
}

interface Entry { c: Candidate; priority: number; seq: number; alive: boolean; at: number }

class Heap {
  private a: Entry[] = [];
  constructor(private readonly better: (x: Entry, y: Entry) => boolean) {}
  get length(): number { return this.a.length; }
  push(e: Entry): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.better(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  peek(): Entry | undefined { return this.a[0]; }
  pop(): Entry | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.better(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.better(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
  clear(): void { this.a = []; }
}

/**
 * Priority queue of refinement candidates: projected area times error deficit, discounted by
 * estimated cost while navigating. One live entry per entity (a newer offer replaces it). When the
 * depth cap is exceeded the lowest-priority entry is evicted, whichever arrived last.
 */
export class RefineQueue {
  private readonly maxDepth: number;
  private readonly max = new Heap((x, y) => x.priority > y.priority || (x.priority === y.priority && x.seq < y.seq));
  private readonly min = new Heap((x, y) => x.priority < y.priority || (x.priority === y.priority && x.seq > y.seq));
  private live = new Map<number, Entry>();
  private seq = 0;
  private evictions = 0;
  private waits: number[] = [];
  /** Virtual or real time source for wait statistics. */
  now: () => number = () => 0;
  onEvict: ((c: Candidate) => void) | null = null;

  constructor(o: { maxDepth?: number } = {}) {
    this.maxDepth = o.maxDepth ?? QUEUE_DEFAULTS.maxDepth;
  }

  get depth(): number { return this.live.size; }

  static priority(c: Candidate): number {
    const deficit = c.errorPx / c.targetPx;
    const costDiscount = c.navigating ? 1 + c.costMs / QUEUE_DEFAULTS.jobTargetMs : 1;
    return (c.areaPx * deficit) / costDiscount;
  }

  offer(c: Candidate): 'queued' | 'rejected' | 'dropped' {
    if (!c.visible) return 'rejected';
    const old = this.live.get(c.entityId);
    if (old) old.alive = false;
    const e: Entry = { c, priority: RefineQueue.priority(c), seq: this.seq++, alive: true, at: this.now() };
    this.live.set(c.entityId, e);
    this.max.push(e);
    this.min.push(e);
    if (this.max.length > 4 * this.live.size + 64) this.compact();
    if (this.live.size > this.maxDepth) {
      const victim = this.evictLowest();
      return victim === e ? 'dropped' : 'queued';
    }
    return 'queued';
  }

  private evictLowest(): Entry | undefined {
    for (;;) {
      const v = this.min.pop();
      if (!v) return undefined;
      if (!v.alive) continue;
      v.alive = false;
      this.live.delete(v.c.entityId);
      this.evictions++;
      this.onEvict?.(v.c);
      return v;
    }
  }

  private compact(): void {
    this.max.clear();
    this.min.clear();
    for (const e of this.live.values()) { this.max.push(e); this.min.push(e); }
  }

  pop(): Candidate | undefined {
    for (;;) {
      const e = this.max.pop();
      if (!e) return undefined;
      if (!e.alive) continue;
      e.alive = false;
      this.live.delete(e.c.entityId);
      this.waits.push(this.now() - e.at);
      if (this.waits.length > 4096) this.waits.splice(0, 2048);
      return e.c;
    }
  }

  /** Drop everything queued (a transform epoch change). */
  clear(): void {
    for (const e of this.live.values()) e.alive = false;
    this.live.clear();
    this.max.clear();
    this.min.clear();
  }

  remove(entityId: number): void {
    const e = this.live.get(entityId);
    if (e) { e.alive = false; this.live.delete(entityId); }
  }

  /** queuestats diagnostics: depth, evictions and wait times (exposed through M7.3). */
  stats(): { depth: number; evictions: number; waitP50Ms: number; waitP99Ms: number } {
    const w = [...this.waits].sort((a, b) => a - b);
    const at = (p: number) => (w.length ? w[Math.min(w.length - 1, Math.floor(w.length * p))]! : 0);
    return { depth: this.live.size, evictions: this.evictions, waitP50Ms: at(0.5), waitP99Ms: at(0.99) };
  }
}
