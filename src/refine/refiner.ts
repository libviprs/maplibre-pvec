import { QUEUE_DEFAULTS, REFINE_DEFAULTS } from '../config/defaults';
import { type CullableEntity, conservativeScreenBounds } from '../render/cull';
import { type SourceAabb, viewportToSourceBounds } from '../transform/inverse';
import { type TransformPipeline, sourceToDevicePx } from '../transform/screen_error';
import type { CurveFamily } from '../workers/evaluator';
import type { JobResult, WorkerPool } from '../workers/pool';
import { RefineCache } from './cache';
import { type DrawTable, type GenerationTracker, type JobTag } from './generation';
import { type PolicyEntity, PolicySweep, measureDisplayedError, needsRefinement } from './policy';
import { type Candidate, type CostInput, RefineQueue, estimateCostMs, planPieces } from './queue';

export interface RefineEntity extends PolicyEntity {
  id: number;
  family: CurveFamily;
  /** Packed control data (decode/advanced.ts layout, or the evaluator's own). Never transferred itself; jobs copy it. */
  control: Float64Array;
  curve: CullableEntity;
  /** Source-space bounds containing the curve (control hull). */
  bounds: SourceAabb;
  cost: Pick<CostInput, 'degree' | 'ctrlCount' | 'knotMultiplicity' | 'trimIntervals'>;
  visible?: boolean;
  areaPx?: number;
}

export interface RefinerOptions {
  pool: WorkerPool;
  tracker: GenerationTracker;
  draw: DrawTable;
  queue: RefineQueue;
  entities: RefineEntity[];
  cache?: RefineCache;
  /** Time source for idle detection (ms). */
  now: () => number;
  /** CPU clock for the per-frame budgets. Defaults to performance.now. */
  cpuNow?: () => number;
  measure?: (e: PolicyEntity, p: TransformPipeline) => number;
  /** Keep every request in `jobLog` (tests and diagnostics). Off by default: the log would grow without bound. */
  logJobs?: boolean;
  /** Called for every accepted upload, before the draw record is staged. The GPU write lives here. */
  onUpload?: (entityId: number, positions: Float64Array, range: { start: number; count: number }) => void;
}

interface Pending {
  tag: JobTag;
  scale: number;
  abort: AbortController;
  pieces: number;
  got: ({ params: Float64Array; positions: Float64Array } | undefined)[];
  have: number;
  evals: number;
  built: TransformPipeline;
  areaPx: number;
  costMs: number;
}

interface PieceWork { entity: RefineEntity; pend: Pending; index: number; t0: number; t1: number; tolerance: number }

export interface FrameStats { policyMs: number; scheduleMs: number; evaluated: number }

/**
 * Wires policy, queue, pool, generation gate and cache for one layer's deferred curves. The
 * camera and georeference come in through setCamera and setGeoReference; frame() does the
 * time-boxed policy sweep and fills the pool.
 */
export class Refiner {
  readonly jobLog: { entityId: number; generation: number; frame: number; pipeline: TransformPipeline }[] = [];
  lastCameraChange = -Infinity;
  private pipeline!: TransformPipeline;
  private viewAabb: SourceAabb | null = null;
  private viewDirty = true;
  private frameNo = 0;
  private pending = new Map<number, Pending>();
  private partial: PieceWork[] = [];
  private sweep: PolicySweep;
  private cache: RefineCache;
  private cpuNow: () => number;
  private resultMs = 0;
  private nextStart = 0;
  private liveBytes = new Map<number, number>();
  private s = { gpuBytes: 0, wastedEvals: 0, totalEvals: 0, coarsenCandidates: 0, requests: 0 };
  private byId = new Map<number, RefineEntity>();

  constructor(private readonly o: RefinerOptions) {
    this.cache = o.cache ?? new RefineCache();
    this.cpuNow = o.cpuNow ?? (() => performance.now());
    for (const e of o.entities) this.byId.set(e.id, e);
    o.queue.now = o.now;
    o.queue.onEvict = (c) => this.abandon(c.entityId, c.generation);
    o.pool.onSettled = () => this.pump();
    this.sweep = new PolicySweep(
      o.entities.length,
      (i) => o.entities[i]!.areaPx ?? 0,
      (i) => this.evaluate(o.entities[i]!),
      { budgetMs: REFINE_DEFAULTS.policyBudgetMs, now: this.cpuNow, onSweepComplete: () => this.sweep.resort((i) => o.entities[i]!.areaPx ?? 0) },
    );
  }

  setCamera(p: TransformPipeline): void {
    const prev = this.pipeline;
    this.pipeline = p;
    const c = prev?.camera, n = p.camera;
    if (!c || c.zoom !== n.zoom || c.bearing !== n.bearing || c.pitch !== n.pitch || c.center[0] !== n.center[0] || c.center[1] !== n.center[1] || c.width !== n.width || c.height !== n.height || c.devicePixelRatio !== n.devicePixelRatio) {
      this.lastCameraChange = this.o.now();
      this.viewDirty = true;
    }
  }

  /** A georeference or projection change: in-flight work is cancelled and stale-epoch results are refused. */
  setGeoReference(p: TransformPipeline): void {
    const epoch = this.o.tracker.bumpEpoch();
    for (const pend of this.pending.values()) pend.abort.abort();
    this.pending.clear();
    this.partial = [];
    this.o.queue.clear();
    this.cache.onGeoReferenceUpdate(p, epoch);
    this.setCamera(p);
    this.viewDirty = true;
    this.lastCameraChange = this.o.now();
  }

  get navigating(): boolean { return this.o.now() - this.lastCameraChange < REFINE_DEFAULTS.idleMs; }

  idle(): boolean { return this.pending.size === 0 && this.o.queue.depth === 0 && this.partial.length === 0; }

  takeResultMs(): number { const v = this.resultMs; this.resultMs = 0; return v; }

  stats() {
    return { ...this.s, cacheHitRate: this.cache.stats().hitRate, cache: this.cache.stats(), queue: this.o.queue.stats(), pending: this.pending.size };
  }

  frame(): FrameStats {
    this.frameNo++;
    const t0 = this.cpuNow();
    this.o.draw.endFrame();
    if (this.viewDirty) this.refreshView();
    const evaluated = this.sweep.runFrame();
    const t1 = this.cpuNow();
    this.pump();
    const t2 = this.cpuNow();
    return { policyMs: t1 - t0, scheduleMs: t2 - t1, evaluated };
  }

  private refreshView(): void {
    const { camera, transform, projection } = this.pipeline;
    this.viewDirty = false;
    try {
      const b = viewportToSourceBounds(camera, transform, projection);
      const m = 0.05 * Math.max(b.maxX - b.minX, b.maxY - b.minY) + 1;
      this.viewAabb = { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
    } catch {
      this.viewAabb = null; // not invertible: fall back to the per-entity test for everything
    }
  }

  /** Per-entity step of the sweep: visibility, area, policy decision, request. */
  private evaluate(e: RefineEntity): 'refine' | 'coarsen' | 'keep' {
    const v = this.viewAabb, b = e.bounds;
    if (v && (b.maxX < v.minX || b.minX > v.maxX || b.maxY < v.minY || b.minY > v.maxY)) {
      e.visible = false; e.areaPx = 0;
      this.drop(e.id);
      return 'keep';
    }
    const sb = conservativeScreenBounds(e.curve, this.pipeline);
    const { width, height, devicePixelRatio: dpr } = this.pipeline.camera;
    const visible = !sb || (sb.maxX >= 0 && sb.minX <= width * dpr && sb.maxY >= 0 && sb.minY <= height * dpr);
    e.visible = visible;
    e.areaPx = sb ? Math.max(1, (sb.maxX - sb.minX) * (sb.maxY - sb.minY)) : 1e6;
    if (!visible) {
      this.drop(e.id);
      return 'keep';
    }
    const d = needsRefinement(e, e.displayed?.generation ?? 0, this.pipeline, { navigating: this.navigating, measure: this.o.measure });
    if (d.action === 'coarsen') this.s.coarsenCandidates++;
    else if (d.action === 'refine') this.request(e, d.errorPx);
    return d.action;
  }

  /** Device px per source unit near the entity (upper bound over both axes). */
  private localScale(e: RefineEntity): number {
    const cx = (e.bounds.minX + e.bounds.maxX) / 2, cy = (e.bounds.minY + e.bounds.maxY) / 2;
    const [x0, y0] = sourceToDevicePx(this.pipeline, cx, cy);
    const [x1, y1] = sourceToDevicePx(this.pipeline, cx + 1, cy);
    const [x2, y2] = sourceToDevicePx(this.pipeline, cx, cy + 1);
    const s = Math.max(Math.hypot(x1 - x0, y1 - y0), Math.hypot(x2 - x0, y2 - y0));
    return Number.isFinite(s) && s > 0 ? s : 1;
  }

  private request(e: RefineEntity, errorPx: number): void {
    const scale = this.localScale(e);
    const cur = this.pending.get(e.id);
    // A pending job built for about this scale is still the right job.
    if (cur && cur.tag.transformEpoch === this.o.tracker.epoch && cur.scale > 0 && Math.max(scale / cur.scale, cur.scale / scale) < 1.5) return;

    const cached = this.cache.get({ entityId: e.id, transformEpoch: this.o.tracker.epoch, zoom: this.pipeline.camera.zoom, dpr: this.pipeline.camera.devicePixelRatio }, this.pipeline);
    if (cached) {
      cur?.abort.abort();
      this.pending.delete(e.id);
      this.o.queue.remove(e.id);
      this.partial = this.partial.filter((w) => w.entity !== e);
      this.accept(e, this.o.tracker.next(e.id), cached.params, cached.positions);
      return;
    }

    cur?.abort.abort();
    const tag = this.o.tracker.next(e.id);
    const costMs = estimateCostMs({ ...e.cost, errorPx: Number.isFinite(errorPx) ? errorPx : 4 * REFINE_DEFAULTS.refinePx, targetPx: REFINE_DEFAULTS.targetPx });
    const cand: Candidate = {
      entityId: e.id, generation: tag.generation, transformEpoch: tag.transformEpoch, visible: true,
      areaPx: e.areaPx ?? 1, errorPx: Number.isFinite(errorPx) ? errorPx : 8, targetPx: REFINE_DEFAULTS.targetPx, costMs, navigating: this.navigating,
    };
    this.partial = this.partial.filter((w) => w.entity !== e);
    const verdict = this.o.queue.offer(cand);
    if (verdict !== 'queued') { this.pending.delete(e.id); return; }
    this.pending.set(e.id, { tag, scale, abort: new AbortController(), pieces: 0, got: [], have: 0, evals: 0, built: this.pipeline, areaPx: cand.areaPx, costMs });
    this.s.requests++;
    if (this.o.logJobs) this.jobLog.push({ entityId: e.id, generation: tag.generation, frame: this.frameNo, pipeline: this.pipeline });
  }

  /** The entity left the view: whatever is queued or running for it is obsolete. */
  private drop(entityId: number): void {
    const p = this.pending.get(entityId);
    if (!p) return;
    p.abort.abort();
    this.o.tracker.next(entityId); // a result already on its way is now stale and is refused at the upload boundary
    this.pending.delete(entityId);
    this.o.queue.remove(entityId);
  }

  private abandon(entityId: number, generation: number): void {
    const p = this.pending.get(entityId);
    if (p && p.tag.generation === generation) this.pending.delete(entityId);
  }

  /** Fill the pool from the queue, within the scheduling budget. */
  pump(): void {
    const t0 = this.cpuNow();
    for (;;) {
      const w = this.nextPiece();
      if (!w) return;
      const buf = this.o.pool.recycler.acquire(w.entity.control.byteLength);
      const control = new Float64Array(buf);
      control.set(w.entity.control);
      const p = this.o.pool.tryRun({ family: w.entity.family, control, t0: w.t0, t1: w.t1, tolerance: w.tolerance, tag: w.pend.tag }, w.pend.abort.signal);
      if (!p) {
        this.o.pool.recycler.release(buf);
        this.partial.unshift(w);
        return;
      }
      void p.then((r) => this.onResult(w, r));
      if (this.cpuNow() - t0 > QUEUE_DEFAULTS.scheduleBudgetMs) return;
    }
  }

  private nextPiece(): PieceWork | undefined {
    for (;;) {
      const w = this.partial.shift();
      if (w) {
        if (this.pending.get(w.entity.id) === w.pend) return w;
        continue;
      }
      const c = this.o.queue.pop();
      if (!c) return undefined;
      const pend = this.pending.get(c.entityId);
      if (!pend || pend.tag.generation !== c.generation || c.transformEpoch !== this.o.tracker.epoch) continue;
      const e = this.byId.get(c.entityId)!;
      const ranges = planPieces(e.curve.domain[0], e.curve.domain[1], c.costMs);
      pend.pieces = ranges.length;
      pend.got = new Array(ranges.length).fill(undefined);
      const tolerance = (REFINE_DEFAULTS.targetPx * 0.9) / pend.scale;
      this.partial = ranges.map(([t0, t1], index) => ({ entity: e, pend, index, t0, t1, tolerance }));
    }
  }

  private onResult(w: PieceWork, r: JobResult): void {
    const t0 = this.cpuNow();
    const evals = r.status === 'error' ? 0 : r.evaluations;
    this.s.totalEvals += evals;
    const tr = this.o.tracker;
    if (r.status === 'cancelled') {
      this.s.wastedEvals += evals;
    } else if (r.status === 'done') {
      // The piece-level pre-filter counts the refusal; the upload boundary is still the gate.
      if (!tr.admit(r.tag)) {
        this.s.wastedEvals += evals;
      } else {
        const pend = w.pend;
        pend.got[w.index] = { params: r.params, positions: r.positions };
        pend.have++;
        pend.evals += evals;
        if (pend.have === pend.pieces) this.assemble(w.entity, pend);
      }
    } else {
      this.pending.delete(w.entity.id);
    }
    this.resultMs += this.cpuNow() - t0;
  }

  private assemble(e: RefineEntity, pend: Pending): void {
    let n = 0;
    for (const g of pend.got) n += g!.params.length;
    n -= pend.pieces - 1; // pieces share their end parameters
    const params = new Float64Array(n), positions = new Float64Array(2 * n);
    let at = 0;
    pend.got.forEach((g, i) => {
      const skip = i === 0 ? 0 : 1;
      params.set(g!.params.subarray(skip), at);
      positions.set(g!.positions.subarray(2 * skip), 2 * at);
      at += g!.params.length - skip;
    });
    if (!this.accept(e, pend.tag, params, positions)) this.s.wastedEvals += pend.evals;
    else {
      const declared = this.o.measure ? this.o.measure({ curve: e.curve, displayed: { params, generation: pend.tag.generation } }, pend.built) : measureDisplayedError({ curve: e.curve, displayed: { params, generation: pend.tag.generation } }, pend.built);
      this.cache.put(
        { entityId: e.id, transformEpoch: pend.tag.transformEpoch, zoom: pend.built.camera.zoom, dpr: pend.built.camera.devicePixelRatio },
        { params, positions },
        { pipeline: pend.built, declaredErrorPx: declared, sourceCenter: [(e.bounds.minX + e.bounds.maxX) / 2, (e.bounds.minY + e.bounds.maxY) / 2] },
        { areaPx: pend.areaPx, costMs: pend.costMs, visible: true },
      );
    }
    if (this.pending.get(e.id) === pend) this.pending.delete(e.id);
  }

  /** The upload boundary: only an admitted result writes and stages a draw record. */
  private accept(e: RefineEntity, tag: JobTag, params: Float64Array, positions: Float64Array): boolean {
    const range = { start: this.nextStart, count: params.length };
    const ok = this.o.draw.upload(tag, range, () => this.o.onUpload?.(e.id, positions, range));
    if (!ok) return false;
    this.nextStart += range.count;
    e.displayed = { params, generation: tag.generation };
    const prev = this.liveBytes.get(e.id) ?? 0;
    this.s.gpuBytes += positions.byteLength - prev;
    this.liveBytes.set(e.id, positions.byteLength);
    return true;
  }
}
