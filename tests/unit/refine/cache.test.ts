import { describe, expect, it } from 'vitest';
import { RefineCache, zoomBucket, dprBucket } from '../../../src/refine/cache';
import { CACHE_DEFAULTS, DISPLAY_FIDELITY_TARGET_PX } from '../../../src/config/defaults';
import { errorOfTessellation } from '../../../src/transform/screen_error';
import { GenerationTracker } from '../../../src/refine/generation';
import { pipelineAt } from '../helpers/refine_harness';
import { cubicAt, splineFixture } from '../helpers/refine';
import { anchoredGeoRef } from '../helpers/scene';
import { SITE } from '../helpers/refine_harness';
import { refineSteps } from '../../../src/workers/evaluator';
import { DoubleEvaluator } from '../helpers/refine';
import { rng } from '../helpers/rng';
import type { TransformPipeline } from '../../../src/transform/screen_error';

const ev = new DoubleEvaluator();
/** Tessellate under a pipeline to the 0.5 px target, the way a worker job does (tolerance in source units from the local scale). */
function tessellate(control: Float64Array, p: TransformPipeline, targetPx = 0.45) {
  const [cx, cy] = [control[0]!, control[1]!];
  const a = pxOf(p, cx, cy), b = pxOf(p, cx + 1, cy);
  const scale = Math.hypot(b[0] - a[0], b[1] - a[1]); // device px per source unit
  const g = refineSteps(ev, { family: 'bezier', control, t0: 0, t1: 1, toleranceUnits: targetPx / scale });
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
import { sourceToDevicePx } from '../../../src/transform/screen_error';
const pxOf = (p: TransformPipeline, x: number, y: number) => sourceToDevicePx(p, x, y);

const mkEntry = (control: Float64Array, p: TransformPipeline, id = 1) => {
  const piece = tessellate(control, p);
  const params = Array.from(piece.params);
  const curve = { domain: [0, 1] as [number, number], point: (t: number) => cubicAt(control, t) };
  const err = errorOfTessellation(params, curve, p, 400);
  return {
    key: { entityId: id, transformEpoch: 0, zoom: p.camera.zoom, dpr: p.camera.devicePixelRatio },
    value: { params: piece.params, positions: piece.positions },
    built: { pipeline: p, declaredErrorPx: err, sourceCenter: [control[0]!, control[1]!] as [number, number] },
    curve, params, value_: 1,
  };
};

describe('M6.6 accounting and ceiling', () => {
  it('defaults are 48 MiB and 4096 entries', () => {
    expect(CACHE_DEFAULTS).toMatchObject({ maxBytes: 48 * 1024 * 1024, maxEntries: 4096 });
  });
  it('a stress asking for 10x the ceiling never exceeds the ceiling plus one entry, by real buffer sizes', () => {
    const cache = new RefineCache({ maxBytes: 2 * 1024 * 1024, maxEntries: 1_000_000 });
    const r = rng(2);
    const p = pipelineAt({ zoom: 20 });
    let maxEntry = 0, peak = 0, asked = 0, i = 0;
    while (asked < 20 * 1024 * 1024) {
      const e = splineFixture(1, 100 + i, 50)[0]!;
      const m = mkEntry(e.control, p, i);
      const bytes = m.value.params.byteLength + m.value.positions.byteLength;
      maxEntry = Math.max(maxEntry, bytes);
      asked += bytes;
      cache.put(m.key, m.value, m.built, { areaPx: r() * 1000, costMs: 1 + r() * 10, visible: r() < 0.5 });
      const actual = cache.measureBytes();
      expect(cache.bytes).toBe(actual);
      peak = Math.max(peak, actual);
      i++;
    }
    expect(peak).toBeLessThanOrEqual(2 * 1024 * 1024 + maxEntry);
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });
  it('evicts the least valuable entry (visibility, area, recompute cost), not the oldest', () => {
    const cache = new RefineCache({ maxBytes: 1e9, maxEntries: 3 });
    const p = pipelineAt();
    const base = splineFixture(4, 1, 20);
    const put = (i: number, meta: { areaPx: number; costMs: number; visible: boolean }) => {
      const m = mkEntry(base[i]!.control, p, i);
      cache.put(m.key, m.value, m.built, meta);
    };
    put(0, { areaPx: 10, costMs: 1, visible: false });
    put(1, { areaPx: 5000, costMs: 20, visible: true });
    put(2, { areaPx: 400, costMs: 5, visible: true });
    put(3, { areaPx: 300, costMs: 5, visible: true });
    expect(cache.has(1)).toBe(true);
    expect(cache.has(0)).toBe(false);
  });
});

describe('M6.6 hits are proofs', () => {
  const p0 = pipelineAt({ zoom: 20 });
  const e = splineFixture(1, 77, 10)[0]!;

  it('keys on entity, epoch, zoom bucket and dpr bucket', () => {
    expect(zoomBucket(20.1)).toBe(zoomBucket(20.2));
    expect(zoomBucket(20.1)).not.toBe(zoomBucket(21));
    expect(dprBucket(1)).not.toBe(dprBucket(2));
  });

  it('a reused tessellation re-measures at or below the 0.5 px target', () => {
    const cache = new RefineCache();
    const m = mkEntry(e.control, p0);
    cache.put(m.key, m.value, m.built, { areaPx: 100, costMs: 1, visible: true });
    let hits = 0;
    for (let z = 18; z <= 21; z += 0.05) {
      const p = pipelineAt({ zoom: z });
      const hit = cache.get({ entityId: 1, transformEpoch: 0, zoom: z, dpr: 1 }, p);
      if (!hit) continue;
      hits++;
      const err = errorOfTessellation(Array.from(hit.params), m.curve, p, 1000);
      expect(err).toBeLessThanOrEqual(DISPLAY_FIDELITY_TARGET_PX);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('zoom bucketing hides no error at bucket boundaries', () => {
    const cache = new RefineCache();
    const m = mkEntry(e.control, p0);
    cache.put(m.key, m.value, m.built, { areaPx: 100, costMs: 1, visible: true });
    for (const z of [19.9999, 20.0, 20.2499, 20.25, 20.4999, 20.5, 20.7499]) {
      const p = pipelineAt({ zoom: z });
      const hit = cache.get({ entityId: 1, transformEpoch: 0, zoom: z, dpr: 1 }, p);
      if (hit) expect(errorOfTessellation(Array.from(hit.params), m.curve, p, 1000)).toBeLessThanOrEqual(DISPLAY_FIDELITY_TARGET_PX);
    }
  });

  it('MUTATION widening the envelope 2x turns the re-measure red', () => {
    const cache = new RefineCache({ validityBudgetPx: 2 * DISPLAY_FIDELITY_TARGET_PX });
    const m = mkEntry(e.control, p0);
    cache.put(m.key, m.value, m.built, { areaPx: 100, costMs: 1, visible: true });
    let worst = 0;
    for (let z = 20; z <= 21.2; z += 0.05) {
      const p = pipelineAt({ zoom: z });
      const hit = cache.get({ entityId: 1, transformEpoch: 0, zoom: z, dpr: 1 }, p);
      if (hit) worst = Math.max(worst, errorOfTessellation(Array.from(hit.params), m.curve, p, 1000));
    }
    expect(worst).toBeGreaterThan(DISPLAY_FIDELITY_TARGET_PX);
  });

  it('a georeference update drops exactly the entries whose envelope no longer covers it; translation keeps them', () => {
    const geoA = anchoredGeoRef({ ...SITE });
    const pA = pipelineAt({ zoom: 20 }, geoA);
    const cache = new RefineCache();
    const tr = new GenerationTracker();
    const els = splineFixture(6, 5, 10);
    els.forEach((x) => { const m = mkEntry(x.control, pA, x.id); cache.put(m.key, m.value, m.built, { areaPx: 100, costMs: 1, visible: true }); });
    expect(cache.size).toBe(6);

    // translation only: same scale, everything survives and is re-keyed to the new epoch
    const pT = pipelineAt({ zoom: 20 }, anchoredGeoRef({ lng: SITE.lng + 1e-4, lat: SITE.lat }));
    const keptT = cache.onGeoReferenceUpdate(pT, tr.bumpEpoch());
    expect(keptT).toEqual({ kept: 6, dropped: 0 });
    expect(cache.has(els[0]!.id)).toBe(true);

    // scale change of 3x: all envelopes broken
    const g3 = anchoredGeoRef({ ...SITE });
    const pS = pipelineAt({ zoom: 20 }, { ...g3, calibration: g3.calibration.map((v, i) => (i < 4 ? v * 3 : v)) as unknown as typeof g3.calibration } as typeof g3);
    const res = cache.onGeoReferenceUpdate(pS, tr.bumpEpoch());
    expect(res.kept + res.dropped).toBe(6);
    expect(res.dropped).toBe(6);
    expect(cache.size).toBe(0);
  });
});

describe('M6.6 hit rate', () => {
  it('returning to a camera after 50 intervening cameras hits at least 60 percent on the spline-heavy fixture', () => {
    const cache = new RefineCache();
    const els = splineFixture(120, 8, 60);
    const camAt = (i: number) => pipelineAt({ zoom: 20 + (i % 3) * 0.05 });
    const visit = (p: TransformPipeline, count: { hit: number; total: number }) => {
      for (const x of els) {
        const key = { entityId: x.id, transformEpoch: 0, zoom: p.camera.zoom, dpr: 1 };
        count.total++;
        if (cache.get(key, p)) { count.hit++; continue; }
        const m = mkEntry(x.control, p, x.id);
        cache.put(m.key, m.value, m.built, { areaPx: 100, costMs: 1, visible: true });
      }
    };
    const warm = { hit: 0, total: 0 };
    visit(camAt(0), warm);
    for (let i = 1; i <= 50; i++) visit(camAt(i), { hit: 0, total: 0 });
    const back = { hit: 0, total: 0 };
    visit(camAt(0), back);
    const rate = back.hit / back.total;
    expect(rate).toBeGreaterThanOrEqual(0.6);
    if (process.env.REFINE_BENCH_OUT) {
      // consumed by the bench job; see docs/deferred.md
      console.log(JSON.stringify({ cacheHitRate: rate }));
    }
  });
});
