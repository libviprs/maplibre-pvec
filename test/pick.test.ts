import { describe, expect, it } from 'vitest';
import { nearestEntity, pickPoint, queryRegion, type PickContext, type Bounds } from '../src/pick/index';

// Source space == lng/lat here; one device px is k / 2^zoom source units.
const pipeline = (zoom: number) => ({
  lngLatToSource: (l: { lng: number; lat: number }) => ({ x: l.lng, y: l.lat }),
  sourceUnitsPerDevicePx: () => 360 / 512 / 2 ** zoom / 2, // dpr 2 tiles
});

interface Ent { id: string; type: string; cx: number; cy: number; r: number }
// Entities are circles; the evaluator is the analytic distance, never a display buffer.
function ctxFor(ents: Ent[], zoom: number, opts: { loaded?: boolean; gen?: () => number } = {}): PickContext {
  return {
    pipeline: pipeline(zoom),
    index: { query: (b: Bounds) => ents.filter((e) => e.cx + e.r >= b.minX && e.cx - e.r <= b.maxX && e.cy + e.r >= b.minY && e.cy - e.r <= b.maxY).map((e) => ({ entityId: e.id, entityType: e.type })), isLoaded: () => opts.loaded ?? true },
    evaluator: {
      distance: (id, p) => { const e = ents.find((x) => x.id === id)!; return Math.abs(Math.hypot(p.x - e.cx, p.y - e.cy) - e.r); },
      intersects: (id, region) => { const e = ents.find((x) => x.id === id)!; return e.cx >= region.minX && e.cx <= region.maxX && e.cy >= region.minY && e.cy <= region.maxY; },
    },
    generation: () => (opts.gen ? opts.gen() : 0),
    maxCandidateRadiusPx: 64,
  };
}

describe('picking (#50 M5.6)', () => {
  for (const zoom of [12, 22]) {
    it(`4 device px hits at 4 px and misses at 6 px (zoom ${zoom}, dpr 2)`, () => {
      const upx = pipeline(zoom).sourceUnitsPerDevicePx();
      const e = [{ id: 'c1', type: 'circle', cx: 0, cy: 0, r: 100 * upx }];
      const ctx = ctxFor(e, zoom);
      const at = (px: number) => pickPoint(ctx, { lng: (100 + px) * upx, lat: 0 }, { radiusPx: 4 });
      expect(at(4).hits.map((h) => h.entityId)).toEqual(['c1']);
      expect(at(6).hits).toEqual([]);
      expect(at(3).hits[0]!.distancePx).toBeCloseTo(3, 6);
    });
  }

  it('same EntityId before and after a refinement replaces the preview', () => {
    let gen = 0;
    const e = [{ id: 'c1', type: 'circle', cx: 0, cy: 0, r: 1 }];
    const ctx = ctxFor(e, 12, { gen: () => gen });
    const p = { lng: 1.00001, lat: 0 };
    const a = pickPoint(ctx, p, { radiusPx: 4 }).hits[0]!;
    gen = 1;
    const b = pickPoint(ctx, p, { radiusPx: 4 }).hits[0]!;
    expect(a.entityId).toBe(b.entityId);
    expect([a.generation, b.generation]).toEqual([0, 1]);
    expect(a.distancePx).toBeCloseTo(b.distancePx, 12);
  });

  it('nearestEntity returns the closest within maxRadiusPx, else nothing', () => {
    const upx = pipeline(12).sourceUnitsPerDevicePx();
    const e = [{ id: 'a', type: 'c', cx: 0, cy: 0, r: 10 * upx }, { id: 'b', type: 'c', cx: 0, cy: 0, r: 14 * upx }];
    const ctx = ctxFor(e, 12);
    expect(nearestEntity(ctx, { lng: 12.5 * upx, lat: 0 }, { maxRadiusPx: 8 })!.hit?.entityId).toBe('b');
    expect(nearestEntity(ctx, { lng: 50 * upx, lat: 0 }, { maxRadiusPx: 8 })!.hit).toBeUndefined();
  });

  it('region query returns exactly the declared id set', () => {
    const ents: Ent[] = [];
    for (let i = 0; i < 100; i++) ents.push({ id: `e${i}`, type: 'c', cx: i % 10, cy: Math.floor(i / 10), r: 0.1 });
    const ctx = ctxFor(ents, 12);
    const r = queryRegion(ctx, { minX: 2, minY: 3, maxX: 4, maxY: 5 });
    const want = new Set<string>();
    for (let x = 2; x <= 4; x++) for (let y = 3; y <= 5; y++) want.add(`e${y * 10 + x}`);
    expect(new Set(r.hits.map((h) => h.entityId))).toEqual(want);
    expect(r.hits.length).toBe(want.size);
  });

  it('reports incomplete when the region is not loaded, never throws or blocks', () => {
    const ctx = ctxFor([], 12, { loaded: false });
    const r = pickPoint(ctx, { lng: 0, lat: 0 }, { radiusPx: 4 });
    expect(r.hits).toEqual([]);
    expect(r.complete).toBe(false);
  });

  it('distance is analytic: a preview that deviates 2 px does not move the result', () => {
    const upx = pipeline(12).sourceUnitsPerDevicePx();
    const e = [{ id: 'c', type: 'c', cx: 0, cy: 0, r: 100 * upx }];
    const ctx = ctxFor(e, 12);
    const h = pickPoint(ctx, { lng: 103 * upx, lat: 0 }, { radiusPx: 4 }).hits[0]!;
    expect(Math.abs(h.distancePx - 3)).toBeLessThanOrEqual(0.25);
  });

  it('1e6 entities: p95 pick under 5 ms', () => {
    const N = 1_000_000, G = 1000;
    const cells: number[][] = Array.from({ length: G * G }, () => []);
    const cx = new Float64Array(N), cy = new Float64Array(N);
    for (let i = 0; i < N; i++) { cx[i] = (i % G) + 0.5; cy[i] = Math.floor(i / G) + 0.5; cells[(i % G) + Math.floor(i / G) * G]!.push(i); }
    const ctx: PickContext = {
      pipeline: { lngLatToSource: (l) => ({ x: l.lng, y: l.lat }), sourceUnitsPerDevicePx: () => 0.01 },
      index: {
        query: (b) => { const o = []; for (let y = Math.max(0, Math.floor(b.minY)); y <= Math.min(G - 1, Math.floor(b.maxY)); y++) for (let x = Math.max(0, Math.floor(b.minX)); x <= Math.min(G - 1, Math.floor(b.maxX)); x++) for (const i of cells[x + y * G]!) o.push({ entityId: String(i), entityType: 'p' }); return o; },
        isLoaded: () => true,
      },
      evaluator: { distance: (id, p) => Math.hypot(p.x - cx[+id]!, p.y - cy[+id]!), intersects: () => true },
      generation: () => 0, maxCandidateRadiusPx: 64,
    };
    const times: number[] = [];
    for (let i = 0; i < 200; i++) { const t = performance.now(); pickPoint(ctx, { lng: 10 + (i * 37) % 900, lat: 10 + (i * 91) % 900 }, { radiusPx: 4 }); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(5);
  });
});
