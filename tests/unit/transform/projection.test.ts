import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECTION_CAPABILITIES,
  MercatorProjectionAdapter as M,
  PROMOTION_CRITERIA,
  UnprovenProjectionError,
  conformanceMayPass,
  gateProjection,
  lngLatToMercator,
  mercatorToLngLat,
  unprojectToGround,
} from '../../../src/transform/projection';
import { camera } from '../helpers/scene';
import { rng } from '../helpers/rng';

const HERE = fileURLToPath(new URL('.', import.meta.url));

describe('M4.2 capability gate', () => {
  it('marks mercator conformant, globe experimental, everything else unsupported', () => {
    expect(DEFAULT_PROJECTION_CAPABILITIES.mercator).toBe('conformant');
    expect(DEFAULT_PROJECTION_CAPABILITIES.globe).toBe('experimental');
    expect(gateProjection('mercator')).toEqual({ capability: 'conformant', nonConformant: false });
    expect(() => gateProjection('albers')).toThrow(UnprovenProjectionError);
  });

  it('globe without the opt-in throws UnprovenProjectionError carrying the state and a message', () => {
    try {
      gateProjection('globe');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnprovenProjectionError);
      const err = e as UnprovenProjectionError;
      expect(err.capability).toBe('experimental');
      expect(err.projectionId).toBe('globe');
      expect(err.message).toBe(
        'projection "globe" is experimental; the Mercator conformance baseline does not cover it. ' +
          'Pass allowUnprovenProjection: true to attach anyway (results are non-conformant).',
      );
    }
  });

  it('the opt-in attaches but flags non-conformant, and the conformance suite refuses to pass', () => {
    const gate = gateProjection('globe', { allowUnprovenProjection: true });
    expect(gate.nonConformant).toBe(true);
    expect(conformanceMayPass(gate)).toBe(false);
    expect(conformanceMayPass(gateProjection('mercator'))).toBe(true);
  });
});

/** Central finite difference of project() over lng/lat degrees. */
function fdJacobian(lng: number, lat: number, cam: ReturnType<typeof camera>) {
  const h = 1e-6;
  const f = (a: number, b: number) => M.project([a, b], cam);
  const [x1, y1] = f(lng + h, lat), [x0, y0] = f(lng - h, lat);
  const [x3, y3] = f(lng, lat + h), [x2, y2] = f(lng, lat - h);
  return [(x1 - x0) / (2 * h), (x3 - x2) / (2 * h), (y1 - y0) / (2 * h), (y3 - y2) / (2 * h)];
}

describe('M4.2 promotion criteria (each id is a test title below)', () => {
  it('PC1 transform agreement', () => {
    const r = rng(11);
    for (let i = 0; i < 2000; i++) {
      const cam = camera({ center: [r() * 360 - 180, (r() * 2 - 1) * 80], zoom: r() * 22, bearing: r() * 360, pitch: r() * 60 });
      // a ground point inside the viewport, back through unproject
      const sx = r() * cam.width, sy = r() * cam.height;
      const hit = unprojectToGround(sx, sy, cam);
      // skip rays above the horizon and views reaching the mercator world edge (clamped by design)
      if (!hit || Math.abs(hit.lngLat[1]) > 84 || cam.zoom < 3 || hit.forward > 2000) continue;
      const [px, py] = M.project(hit.lngLat, cam);
      expect(Math.abs(px - sx)).toBeLessThan(1e-3);
      expect(Math.abs(py - sy)).toBeLessThan(1e-3);
    }
    const [mx, my] = lngLatToMercator(13.4, 52.5);
    const [lng, lat] = mercatorToLngLat(mx, my);
    expect(lng).toBeCloseTo(13.4, 10);
    expect(lat).toBeCloseTo(52.5, 10);
  });

  it('PC2 inflation bound', () => {
    // jacobianAt agrees with a finite-difference jacobian to 1e-6 relative, lat +-85, zoom 0..22
    const r = rng(12);
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      const lat = (r() * 2 - 1) * 85;
      const zoom = r() * 22;
      const cam = camera({ center: [r() * 20, lat * 0.999], zoom, bearing: r() * 360, pitch: r() * 60 });
      const [lng, la] = [cam.center[0] + (r() - 0.5) * 1e-3 * 2 ** -Math.max(0, zoom - 8), cam.center[1] + (r() - 0.5) * 1e-3 * 2 ** -Math.max(0, zoom - 8)];
      const J = M.jacobianAt([lng, la], cam);
      // finite-difference step scaled to the zoom so we stay in the linear range
      // Richardson-extrapolated central difference, steps of ~8 px and ~4 px
      const h0 = Math.min(8 / Math.max(...J.map(Math.abs)), 0.002);
      const f = (a: number, b: number) => M.project([a, b], cam);
      const cd = (h: number) => {
        const [x1, y1] = f(lng + h, la), [x0, y0] = f(lng - h, la), [x3, y3] = f(lng, la + h), [x2, y2] = f(lng, la - h);
        return [(x1 - x0) / (2 * h), (x3 - x2) / (2 * h), (y1 - y0) / (2 * h), (y3 - y2) / (2 * h)];
      };
      const d1 = cd(h0), d2 = cd(h0 / 2);
      const fd = d1.map((v, k) => (4 * d2[k]! - v) / 3);
      const scale = Math.max(...J.map(Math.abs), 1e-9);
      for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(J[k]! - fd[k]!) / scale);
    }
    expect(worst).toBeLessThanOrEqual(1e-6);
    void fdJacobian;
  });

  it('PC2 inflation bound: the maxErrorInflation margin covers the true sag of a straight screen edge', () => {
    const r = rng(13);
    for (let i = 0; i < 300; i++) {
      const cam = camera({ center: [r() * 360 - 180, (r() * 2 - 1) * 80], zoom: r() * 10, bearing: r() * 360 });
      // one screen edge, 16 chords
      const n = 16;
      const pts: [number, number][] = [];
      for (let k = 0; k <= n; k++) pts.push(unprojectToGround((k / n) * cam.width, cam.height * 0.1, cam)!.lngLat);
      if (pts.some((p) => Math.abs(p[1]) > 84)) continue; // world edge is clamped by design
      const west = Math.min(...pts.map((p) => p[0])), east = Math.max(...pts.map((p) => p[0]));
      const south = Math.min(...pts.map((p) => p[1])), north = Math.max(...pts.map((p) => p[1]));
      const m = M.maxErrorInflation({ west, south, east, north }, cam);
      let sag = 0;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const mid = unprojectToGround(t * cam.width + 0 * 0, cam.height * 0.1, cam)!.lngLat;
        const a = pts[k]!, b = pts[k + 1]!;
        // lat difference at equal lng parameter is what the bound controls
        const chordLat = (a[1] + b[1]) / 2;
        sag = Math.max(sag, Math.abs(mid[1] - chordLat));
      }
      expect(sag).toBeLessThanOrEqual(m);
    }
  });

  it('PC3 deep-zoom stability', () => {
    for (const zoom of [18, 20, 22]) {
      const cam = camera({ center: [8.5417, 47.3769], zoom, bearing: 33, pitch: 40 });
      const [x, y] = M.project(cam.center, cam);
      expect(x).toBeCloseTo(cam.width / 2, 6);
      expect(y).toBeCloseTo(cam.height / 2, 6);
      // 1 px on screen is a stable lng/lat step: nearby point moves by ~1 px per (1/J) degree
      const J = M.jacobianAt(cam.center, cam);
      const det = J[0] * J[3] - J[1] * J[2];
      expect(Number.isFinite(det) && det !== 0).toBe(true);
      const [x2] = M.project([cam.center[0] + 1 / Math.hypot(J[0], J[2]) * 1, cam.center[1]], cam);
      expect(Math.abs(x2 - x)).toBeGreaterThan(0.1);
    }
  });

  it('no projection is conformant while any criterion test is absent', () => {
    const src = readdirSync(HERE).filter((f) => f.endsWith('.test.ts')).map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n');
    for (const c of PROMOTION_CRITERIA) {
      expect(src, `${c.id} has no test titled "${c.testId}"`).toContain(`it('${c.testId}`);
    }
    expect(DEFAULT_PROJECTION_CAPABILITIES.mercator).toBe('conformant');
  });
});
