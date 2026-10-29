import { CACHE_DEFAULTS, DISPLAY_FIDELITY_TARGET_PX } from '../config/defaults';
import { type DeclaredTessellation, tessellationStillValid } from '../transform/rebase';
import type { TransformPipeline } from '../transform/screen_error';

export const zoomBucket = (zoom: number): number => Math.floor(zoom / CACHE_DEFAULTS.zoomBucketWidth);
export const dprBucket = (dpr: number): number => Math.round(dpr / CACHE_DEFAULTS.dprBucketWidth);

export interface CacheKey {
  entityId: number;
  transformEpoch: number;
  zoom: number;
  dpr: number;
}

export interface CachedTessellation {
  params: Float64Array;
  positions: Float64Array;
}

/** What the tessellation was built under and what error it declared. Its envelope is derived from this (M4.4/M4.6). */
export interface BuiltUnder extends Omit<DeclaredTessellation, 'blockId'> {
  pipeline: TransformPipeline;
}

/** Refinement value inputs: visibility, projected area, estimated recompute cost. */
export interface ValueMeta {
  areaPx: number;
  costMs: number;
  visible: boolean;
}

interface Entry {
  key: string;
  entityId: number;
  value: CachedTessellation;
  built: BuiltUnder;
  meta: ValueMeta;
  bytes: number;
  score: number;
}

const keyOf = (k: CacheKey): string => `${k.entityId}|${k.transformEpoch}|${zoomBucket(k.zoom)}|${dprBucket(k.dpr)}`;
const scoreOf = (m: ValueMeta): number => (m.visible ? 1 : 1e-6) * (1 + m.areaPx) * (1 + m.costMs);

/**
 * Bounded tessellation cache. A hit is a proof: the entry is reused only when the declared error,
 * scaled by the largest singular value of the pipeline Jacobian ratio between the build and the
 * request (tessellationStillValid), is still within budget. The ceiling counts the real
 * byteLength of the stored buffers.
 */
export class RefineCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly budgetPx: number;
  private map = new Map<string, Entry>();
  bytes = 0;
  private c = { hits: 0, misses: 0, evictions: 0 };

  constructor(o: { maxBytes?: number; maxEntries?: number; validityBudgetPx?: number } = {}) {
    this.maxBytes = o.maxBytes ?? CACHE_DEFAULTS.maxBytes;
    this.maxEntries = o.maxEntries ?? CACHE_DEFAULTS.maxEntries;
    this.budgetPx = o.validityBudgetPx ?? DISPLAY_FIDELITY_TARGET_PX;
  }

  get size(): number { return this.map.size; }

  has(entityId: number): boolean {
    for (const e of this.map.values()) if (e.entityId === entityId) return true;
    return false;
  }

  /** Recount from the stored buffers, independent of the running total. */
  measureBytes(): number {
    let n = 0;
    for (const e of this.map.values()) n += e.value.params.byteLength + e.value.positions.byteLength;
    return n;
  }

  put(key: CacheKey, value: CachedTessellation, built: BuiltUnder, meta: ValueMeta): void {
    const k = keyOf(key);
    const old = this.map.get(k);
    if (old) { this.bytes -= old.bytes; this.map.delete(k); }
    const bytes = value.params.byteLength + value.positions.byteLength;
    this.map.set(k, { key: k, entityId: key.entityId, value, built, meta, bytes, score: scoreOf(meta) });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.map.size > this.maxEntries) {
      if (!this.evictLowest()) break;
    }
  }

  private evictLowest(): boolean {
    let worst: Entry | undefined;
    for (const e of this.map.values()) if (!worst || e.score < worst.score) worst = e;
    if (!worst) return false;
    this.map.delete(worst.key);
    this.bytes -= worst.bytes;
    this.c.evictions++;
    return true;
  }

  get(key: CacheKey, now: TransformPipeline): CachedTessellation | undefined {
    const e = this.map.get(keyOf(key));
    if (e && tessellationStillValid(e.built.pipeline, now, { ...e.built, blockId: e.entityId }, this.budgetPx)) {
      this.c.hits++;
      return e.value;
    }
    this.c.misses++;
    return undefined;
  }

  /** Update an entry's value inputs, e.g. when its screen area changed. */
  touch(key: CacheKey, meta: ValueMeta): void {
    const e = this.map.get(keyOf(key));
    if (e) { e.meta = meta; e.score = scoreOf(meta); }
  }

  /**
   * A georeference or projection change: keep exactly the entries whose envelope still covers the
   * new transform (a translation keeps them), re-key them to the new epoch, drop the rest.
   */
  onGeoReferenceUpdate(next: TransformPipeline, epoch: number): { kept: number; dropped: number } {
    let kept = 0, dropped = 0;
    const survivors = new Map<string, Entry>();
    for (const e of this.map.values()) {
      if (tessellationStillValid(e.built.pipeline, next, { ...e.built, blockId: e.entityId }, this.budgetPx)) {
        const [, , z, d] = e.key.split('|');
        const k = `${e.entityId}|${epoch}|${z}|${d}`;
        // the build pipeline stays: later checks compare against it, so scale changes accumulate
        const moved: Entry = { ...e, key: k };
        survivors.set(k, moved);
        kept++;
      } else {
        this.bytes -= e.bytes;
        dropped++;
      }
    }
    this.map = survivors;
    return { kept, dropped };
  }

  stats(): { hits: number; misses: number; evictions: number; hitRate: number; entries: number; bytes: number } {
    const t = this.c.hits + this.c.misses;
    return { ...this.c, hitRate: t ? this.c.hits / t : 0, entries: this.map.size, bytes: this.bytes };
  }
}
