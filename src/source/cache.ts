export type Tier = "compressed" | "decoded" | "gpu";

/** PROVISIONAL (M8.6): per-tier ceilings used when the host sets none. */
const DEFAULT_CEILINGS: Record<Tier, number> = {
  compressed: 64 * 1024 * 1024,
  decoded: 128 * 1024 * 1024,
  gpu: 128 * 1024 * 1024,
};
const TIERS: readonly Tier[] = ["compressed", "decoded", "gpu"];

export interface EntryMeta {
  /** On screen now: outranks everything that is not. */
  visible?: boolean;
  /** A refined generation outranks a preview of the same entity. */
  refined?: boolean;
  entityId?: number;
  /** Higher generations supersede lower ones of the same entityId. */
  generation?: number;
  /** A raster tile: the raster and the pyramid level it belongs to, for the level-distance term of the eviction order. */
  raster?: number;
  level?: number;
  /** What the entry holds, handed to `release` when it goes. For the GPU tier, the WebGLBuffer. */
  payload?: unknown;
}
interface Entry extends EntryMeta {
  bytes: number;
  lastUsed: number;
}
export interface Eviction {
  tier: Tier;
  key: string;
  bytes: number;
  /** The value terms that decided it, lowest value goes first. */
  terms: { visible: boolean; refined: boolean; lastUsed: number; levelDistance?: number };
}

/**
 * Three separately accounted tiers. Eviction order is visibility, then refinement, then recency,
 * with the key as the last tie-break so runs are reproducible. Two raster tiles compare by visibility ("in the current
 * plan"), then by how far their level is from the level the plan wants (a retained coarser level outranks a finer level
 * that is no longer wanted), then recency, then the key. A GPU entry is released through
 * `release` (the layer's deleteBuffer path), so evicting it deletes the buffer.
 */
export class TieredCache {
  readonly evictionLog: Eviction[] = [];
  private tiers: Record<Tier, Map<string, Entry>> = { compressed: new Map(), decoded: new Map(), gpu: new Map() };
  private used: Record<Tier, number> = { compressed: 0, decoded: 0, gpu: 0 };
  private peaks: Record<Tier, number> = { compressed: 0, decoded: 0, gpu: 0 };
  private ceilings: Record<Tier, number>;
  private tick = 0;
  private wanted = new Map<number, number>();

  constructor(
    ceilings: Partial<Record<Tier, number>> = {},
    private hooks: { release?: (tier: Tier, key: string, payload: unknown) => void } = {},
  ) {
    this.ceilings = { ...DEFAULT_CEILINGS, ...ceilings };
  }

  ceiling(t: Tier): number {
    return this.ceilings[t];
  }
  bytes(t: Tier): number {
    return this.used[t];
  }
  peak(t: Tier): number {
    return this.peaks[t];
  }
  keys(t: Tier): string[] {
    return [...this.tiers[t].keys()];
  }
  has(t: Tier, key: string): boolean {
    return this.tiers[t].has(key);
  }
  payload(t: Tier, key: string): unknown {
    return this.tiers[t].get(key)?.payload;
  }
  get(t: Tier, key: string): unknown {
    const e = this.tiers[t].get(key);
    if (e) e.lastUsed = ++this.tick;
    return e?.payload;
  }

  /** Returns false when the entry was refused (too big, or already superseded). */
  put(t: Tier, key: string, data: number | Uint8Array, meta: EntryMeta = {}): boolean {
    const bytes = typeof data === "number" ? data : data.byteLength;
    if (bytes > this.ceilings[t]) return false;
    const map = this.tiers[t];
    if (meta.entityId !== undefined && meta.generation !== undefined) {
      for (const [k, e] of map) {
        if (e.entityId !== meta.entityId || e.generation === undefined) continue;
        if (e.generation > meta.generation) return false;
        if (e.generation < meta.generation && k !== key) this.remove(t, k);
      }
    }
    if (map.has(key)) this.remove(t, key);
    while (this.used[t] + bytes > this.ceilings[t]) this.evictOne(t);
    map.set(key, { ...meta, payload: meta.payload ?? (typeof data === "number" ? undefined : data), bytes, lastUsed: ++this.tick });
    this.used[t] += bytes;
    this.peaks[t] = Math.max(this.peaks[t], this.used[t]);
    return true;
  }

  /** The level the current plan wants of each raster, for the eviction order of raster tiles. */
  setWantedLevels(m: ReadonlyMap<number, number>): void {
    this.wanted = new Map(m);
  }

  /** Remove one entry without evicting it: it moved to another tier, or its owner released it. Releases the payload. */
  drop(t: Tier, key: string): void {
    this.remove(t, key);
  }

  /** Mark exactly these keys (in every tier) as on screen. */
  setVisible(keys: ReadonlySet<string>): void {
    for (const t of TIERS) for (const [k, e] of this.tiers[t]) e.visible = keys.has(k);
  }

  /** Drop everything, releasing each entry. Used by version invalidation and layer removal. */
  clear(): void {
    for (const t of TIERS) for (const k of this.keys(t)) this.remove(t, k);
  }

  private remove(t: Tier, key: string): void {
    const e = this.tiers[t].get(key);
    if (!e) return;
    this.tiers[t].delete(key);
    this.used[t] -= e.bytes;
    this.hooks.release?.(t, key, e.payload);
  }

  private evictOne(t: Tier): void {
    let victim: [string, Entry] | undefined;
    for (const kv of this.tiers[t]) if (!victim || this.lower(kv, victim)) victim = kv;
    if (!victim) return;
    const [key, e] = victim;
    this.evictionLog.push({ tier: t, key, bytes: e.bytes, terms: { visible: !!e.visible, refined: !!e.refined, lastUsed: e.lastUsed, ...(e.raster !== undefined ? { levelDistance: this.distance(e) } : {}) } });
    this.remove(t, key);
  }

  private lower(a: [string, Entry], b: [string, Entry]): boolean {
    const [ka, ea] = a;
    const [kb, eb] = b;
    if (!!ea.visible !== !!eb.visible) return !ea.visible;
    if (ea.raster !== undefined && eb.raster !== undefined) {
      const da = this.distance(ea), db = this.distance(eb);
      if (da !== db) return da > db;
    }
    if (!!ea.refined !== !!eb.refined) return !ea.refined;
    if (ea.lastUsed !== eb.lastUsed) return ea.lastUsed < eb.lastUsed;
    return ka < kb;
  }

  /** Levels below the wanted one count whole, levels above it half a level more, so a retained coarser level outranks a finer one of equal distance. */
  private distance(e: Entry): number {
    const w = this.wanted.get(e.raster!);
    if (w === undefined || e.level === undefined) return 0;
    return e.level < w ? w - e.level : e.level - w + 0.5;
  }
}
