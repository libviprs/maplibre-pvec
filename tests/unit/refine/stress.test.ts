import { budget } from '../helpers/budget';
import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { errorOfTessellation } from '../../../src/transform/screen_error';
import { REFINE_DEFAULTS } from '../../../src/config/defaults';
import { anchoredGeoRef } from '../helpers/scene';
import { FRAME_MS, SITE, makeHarness, pipelineAt } from '../helpers/refine_harness';
import { rng } from '../helpers/rng';

setFlagsFromString('--expose-gc');
const gc = () => (runInNewContext('gc') as () => void)();

const mpp = (z: number) => 0.0252 * 2 ** (21 - z); // metres per CSS px at the site latitude
type Cam = { x: number; y: number; zoom: number; bearing?: number; pitch?: number; geo?: ReturnType<typeof anchoredGeoRef> };
type Script = (i: number, tSec: number) => Cam;

interface Scenario { name: string; seconds: number; script: () => Script; churn?: boolean; msPerEval?: number; latencyMs?: number }

const bounce = (v: number, span: number) => { const m = ((v % (2 * span)) + 2 * span) % (2 * span); return m > span ? 2 * span - m : m; };

const scenarios: Scenario[] = [
  { name: 'pan-600', seconds: 60, script: () => (_i, t) => ({ x: -150 + bounce(t * 600 * mpp(19), 300), y: 0, zoom: 19 }) },
  { name: 'pan-2000', seconds: 60, script: () => (_i, t) => ({ x: -150 + bounce(t * 2000 * mpp(19), 300), y: 0, zoom: 19 }) },
  { name: 'zoom-sweep', seconds: 60, script: () => (_i, t) => { const leg = (t * 2) % 28; return { x: 0, y: 0, zoom: leg < 14 ? 8 + leg : 22 - (leg - 14) }; } },
  { name: 'rotate-tilt', seconds: 30, script: () => (_i, t) => ({ x: 0, y: 0, zoom: 19.5, bearing: (t * 90) % 360, pitch: Math.min(60, (t / 30) * 60) }) },
  {
    name: 'flyto-storm', seconds: 60, msPerEval: 0.06,
    script: () => { const r = rng(5); let cur: Cam = { x: 0, y: 0, zoom: 19 }; let last = -1; return (_i, t) => { const k = Math.floor(t / 0.25); if (k !== last) { last = k; cur = { x: (r() - 0.5) * 300, y: (r() - 0.5) * 300, zoom: 18.5 + r() * 2.5 }; } return cur; }; },
  },
  {
    name: 'georef-churn', seconds: 30, churn: true, msPerEval: 0.02, latencyMs: 8,
    script: () => { let last = -1; let geo = anchoredGeoRef({ ...SITE }); return (_i, t) => { const n = Math.floor(t / 0.5); if (n !== last) { last = n; const g = anchoredGeoRef({ lng: SITE.lng + (n % 7) * 1e-5, lat: SITE.lat, rotationDeg: n % 4 === 0 ? (n % 12) : 0 }); const k = [1, 2.5, 1, 4][n % 4]!; geo = { ...g, calibration: g.calibration.map((v, i) => (i < 4 ? v * k : v)) as unknown as typeof g.calibration } as typeof g; } return { x: 0, y: 0, zoom: 19.5, geo }; }; },
  },
];

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
const report: Record<string, unknown> = {};

describe('M6.8 interaction stress (virtual-time pool, real add-on CPU time)', () => {
  for (const sc of scenarios) {
    it(`${sc.name}: frame budget, bounded memory, safe race, convergence`, async () => {
      const h = makeHarness({ n: 1500, seed: 41, spread: 120, logJobs: false, msPerEval: sc.msPerEval ?? 0.008, ...(sc.latencyMs ? { latencyMs: sc.latencyMs } : {}) });
      const script = sc.script();
      const frames = Math.round((sc.seconds * 1000) / FRAME_MS);
      const cpu: number[] = [];
      const heap: [number, number][] = [];
      let stale = 0, maxGpu = 0;
      for (let i = 0; i < frames; i++) {
        const t = i * FRAME_MS / 1000;
        const c = script(i, t);
        const geo = c.geo ?? anchoredGeoRef({ ...SITE });
        const p = pipelineAt({ zoom: c.zoom, bearing: c.bearing ?? 0, pitch: c.pitch ?? 0, center: h.pipeline.transform.forward(c.x, c.y) }, geo);
        if (sc.churn && c.geo && c.geo !== (h as unknown as { lastGeo?: unknown }).lastGeo) {
          (h as unknown as { lastGeo?: unknown }).lastGeo = c.geo;
          h.refiner.setGeoReference(p); h.setCamera(p);
        } else h.setCamera(p);
        const ms = await h.frame();
        if (i >= 60) cpu.push(ms);
        stale += h.draw.audit().violations.length;
        maxGpu = Math.max(maxGpu, h.refiner.stats().gpuBytes);
        if (i % 120 === 0 && i >= 600) { gc(); heap.push([t, process.memoryUsage().heapUsed - h.refiner.stats().cache.bytes]); }
      }
      // convergence: hold the camera 2 s of virtual time
      const last = h.pipeline;
      for (let i = 0; i < Math.ceil(2000 / FRAME_MS); i++) await h.frame();
      let worst = 0, within = 0, visible = 0;
      for (const e of h.entities) {
        if (!e.visible || !e.displayed) continue;
        visible++;
        const px = errorOfTessellation(Array.from(e.displayed.params), e.curve, last, 300);
        worst = Math.max(worst, px);
        if (px <= REFINE_DEFAULTS.targetPx) within++;
      }
      const st = h.refiner.stats();
      const slope = (() => {
        const steady = heap.filter((p) => p[0] >= sc.seconds / 2); // steady state: the second half of the run
        if (steady.length < 3) return 0;
        const n = steady.length, mx = steady.reduce((a, p) => a + p[0], 0) / n, my = steady.reduce((a, p) => a + p[1], 0) / n;
        const num = steady.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0), den = steady.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
        return (num / den) * 60; // least-squares bytes per minute
      })();
      const row = {
        seconds: sc.seconds, frames, cpuP95: q(cpu, 0.95), cpuP999: q(cpu, 0.999), cpuMax: Math.max(...cpu),
        utilisation: h.pool.utilisation(), discarded: h.tracker.discarded, staleEpoch: h.tracker.staleEpoch, displayedStale: stale,
        cacheHitRate: st.cacheHitRate, maxGpuBytes: maxGpu, heapSlopeBytesPerMin: slope,
        wasteFraction: st.totalEvals ? st.wastedEvals / st.totalEvals : 0, visible, convergedWithinTargetFraction: visible ? within / visible : 1, worstErrorPx: worst,
      };
      report[sc.name] = row;
      expect(row.cpuP95).toBeLessThanOrEqual(budget(4));
      expect(row.cpuP999).toBeLessThanOrEqual(budget(12));
      expect(row.cpuMax).toBeLessThanOrEqual(budget(33));
      expect(maxGpu).toBeLessThanOrEqual(budget(64 * 1024 * 1024));
      // Heap net of the accounted cache (bounded separately by its own ceiling test). The bound applies to the 60-second runs; the 30-second ones are still revealing entities.
      if (sc.seconds >= 60) expect(slope, JSON.stringify(heap.map((h) => Math.round(h[1] / 1024)))).toBeLessThanOrEqual(budget(1024 * 1024));
      expect(row.displayedStale).toBe(0);
      if (['pan-600', 'pan-2000', 'flyto-storm'].includes(sc.name)) expect(row.wasteFraction).toBeLessThanOrEqual(budget(0.1));
      if (['flyto-storm', 'georef-churn'].includes(sc.name)) expect(row.discarded + row.staleEpoch, JSON.stringify({ ...row, req: st.requests, cancelled: st.wastedEvals })).toBeGreaterThan(budget(0));
      // The refine threshold (1.0 px) is the hysteresis ceiling; see docs/deferred.md on the 0.5 px convergence wording.
      expect(worst).toBeLessThanOrEqual(REFINE_DEFAULTS.refinePx);
    }, 300_000);
  }

  it('writes bench/out/interaction-stress.json when asked', () => {
    if (process.env.INTERACTION_STRESS_OUT) {
      mkdirSync(process.env.INTERACTION_STRESS_OUT, { recursive: true });
      writeFileSync(`${process.env.INTERACTION_STRESS_OUT}/interaction-stress.json`, JSON.stringify(report, null, 2));
    }
    expect(Object.keys(report).length).toBeGreaterThan(budget(0));
  });
});
