import { DEFAULTS } from '../config/defaults';

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export type Geometry =
  | { type: 'line' | 'polyline'; points: number[] }
  | { type: 'arc' | 'conic'; params: number[] };

/** What the WASM decoder hands over for one Tier 0 entity. */
export interface RawEntity {
  entityId: string;
  kind: 'exact' | 'preview';
  geometry: Geometry;
  bounds: Bounds;
  /** Required for previews only. */
  declaredErrorPx?: number;
}
/**
 * Cursor over the Tier 0 blocks in the WASM decoder. `endsBlock`, when the cursor has it, says whether what the last `next`
 * returned ends a block (a leaf of the spatial directory, say), so the decoder counts the next block from zero. A cursor
 * without it is one block from its first entity to its last.
 */
export interface BlockCursor { next(maxEntities: number): RawEntity[] | null; endsBlock?(): boolean }

/** Exact cheap geometry. It has no conformance label and no error field. */
export interface ExactDraw { kind: 'exact'; entityId: string; generation: 0; geometry: Geometry; bounds: Bounds }
/** Bounded-error stand-in for a deferred analytic entity. */
export interface PreviewDraw {
  kind: 'preview'; entityId: string; generation: 0; geometry: Geometry; bounds: Bounds;
  declaredErrorPx: number; conformance: 'display-fidelity';
}
export type EntityDraw = ExactDraw | PreviewDraw;

export interface Tier0Limits { maxEntitiesPerBlock: number; maxSliceMs: number; now: () => number }

export class Tier0Decoder {
  private readonly limits: Tier0Limits;
  private decoded = 0;
  /** The longest recent `next` of the cursor: a slice does not start another call that, if it were twice as long, could not end inside the budget. It fades by 3 percent a slice, so one slow call (a first call, a collection) does not shorten every slice after it. */
  private longestCall = 0;

  constructor(l: Partial<Tier0Limits> = {}) {
    this.limits = {
      maxEntitiesPerBlock: l.maxEntitiesPerBlock ?? DEFAULTS.maxEntitiesPerBlock,
      maxSliceMs: l.maxSliceMs ?? DEFAULTS.maxDecodeSliceMs,
      now: l.now ?? (() => performance.now()),
    };
  }

  /** Decode until the slice budget is spent. Returns null when the block is finished. */
  decodeSlice(cursor: BlockCursor): { draws: EntityDraw[] } | null {
    const start = this.limits.now();
    const draws: EntityDraw[] = [];
    let callStart = start;
    let longestHere = 0;
    // A slice keeps room for two of the longest call seen: the next one is often longer (a collection, a heavier page), by up to 80 percent on the 1e6 file.
    do {
      const batch = cursor.next(8);
      if (batch === null) { this.decoded = 0; return draws.length ? { draws } : null; }
      this.decoded += batch.length;
      if (this.decoded > this.limits.maxEntitiesPerBlock) throw new Error(`block exceeds maxEntitiesPerBlock (${this.limits.maxEntitiesPerBlock})`);
      if (cursor.endsBlock?.()) this.decoded = 0;
      for (const e of batch) draws.push(toDraw(e));
      const now = this.limits.now();
      longestHere = Math.max(longestHere, now - callStart);
      this.longestCall = Math.max(this.longestCall, longestHere);
      callStart = now;
    } while (callStart - start + 2 * this.longestCall < this.limits.maxSliceMs);
    this.longestCall = Math.max(longestHere, this.longestCall * 0.97);
    return { draws };
  }

  decodeAll(cursor: BlockCursor): EntityDraw[] {
    const out: EntityDraw[] = [];
    for (let s = this.decodeSlice(cursor); s; s = this.decodeSlice(cursor)) out.push(...s.draws);
    return out;
  }
}

function toDraw(e: RawEntity): EntityDraw {
  if (e.kind === 'exact') return { kind: 'exact', entityId: e.entityId, generation: 0, geometry: e.geometry, bounds: e.bounds };
  if (!(typeof e.declaredErrorPx === 'number' && e.declaredErrorPx >= 0)) throw new Error(`preview ${e.entityId} lacks declaredErrorPx`);
  return { kind: 'preview', entityId: e.entityId, generation: 0, geometry: e.geometry, bounds: e.bounds, declaredErrorPx: e.declaredErrorPx, conformance: 'display-fidelity' };
}

/** Coverage is the set difference: ids the spatial index puts in view minus ids submitted. */
export class CoverageTracker {
  private readonly submitted = new Set<string>();
  private fired = false;
  private remaining: number;

  constructor(private readonly expected: ReadonlySet<string>, private readonly onComplete: () => void) {
    this.remaining = expected.size;
  }

  submit(id: string): void {
    if (!this.submitted.has(id) && this.expected.has(id)) this.remaining--;
    this.submitted.add(id);
    if (!this.fired && this.remaining === 0) { this.fired = true; this.onComplete(); }
  }

  missing(): Set<string> {
    const m = new Set<string>();
    for (const id of this.expected) if (!this.submitted.has(id)) m.add(id);
    return m;
  }

  get complete(): boolean { return this.fired; }
}

/** Refuses any deferred-block request until tier0complete. */
export class FetchGate {
  constructor(private readonly coverage: CoverageTracker) {}
  mayRequest(tier: 'tier0' | 'deferred'): boolean { return tier === 'tier0' || this.coverage.complete; }
}
