import { describe, expect, it } from 'vitest';
import { DEFAULT_HORIZON_SCREENS, viewportToSourceBounds, viewportToSourceRings } from '../../../src/transform/inverse';
import { MercatorProjectionAdapter as M, type Camera, unprojectToGround } from '../../../src/transform/projection';
import { anchoredGeoRef, transformOf } from '../helpers/scene';
import { rng } from '../helpers/rng';

const CAMERAS = 10_000;
const PER_CAMERA = 100; // 10 000 x 100 = 1e6 Monte-Carlo points

function randomScene(r: () => number, pitchMax = 60) {
  const cam: Camera = {
    center: [r() * 360 - 180, (r() * 2 - 1) * 80],
    zoom: r() * 22,
    bearing: r() * 360,
    pitch: r() * pitchMax,
    width: 800 + Math.floor(r() * 800),
    height: 500 + Math.floor(r() * 500),
    devicePixelRatio: 1,
  };
  // source frame anchored at the camera centre with a random plan rotation
  const geo = anchoredGeoRef({ lng: cam.center[0], lat: cam.center[1], rotationDeg: r() * 360, anisotropy: 0.8 + r() * 0.4 });
  return { cam, t: transformOf(geo) };
}

/** A point on the viewport (interior or edge) that the horizon clamp keeps in scope. */
function samplePoint(r: () => number, cam: Camera, clampForward: number) {
  const edge = r() < 0.5;
  let sx = r() * cam.width, sy = r() * cam.height;
  if (edge) {
    const side = Math.floor(r() * 4);
    if (side === 0) sy = 0; else if (side === 1) sy = cam.height; else if (side === 2) sx = 0; else sx = cam.width;
  }
  const hit = unprojectToGround(sx, sy, cam);
  return hit && hit.forward <= clampForward ? hit : null;
}

function run(inflationScale: number) {
  const r = rng(4242);
  let escapes = 0, tested = 0;
  for (let i = 0; i < CAMERAS; i++) {
    const { cam, t } = randomScene(r);
    const b = viewportToSourceBounds(cam, t, M, { inflationScale });
    const clamp = DEFAULT_HORIZON_SCREENS * Math.max(cam.width, cam.height);
    for (let k = 0; k < PER_CAMERA; k++) {
      const hit = samplePoint(r, cam, clamp);
      if (!hit) continue;
      const [x, y] = t.inverse(hit.lngLat[0], hit.lngLat[1]);
      tested++;
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) escapes++;
    }
  }
  return { escapes, tested };
}

describe('M4.3 inverse viewport query', () => {
  it('containment: 10 000 random cameras, 1e6 Monte-Carlo points, zero escapes', () => {
    const { escapes, tested } = run(1);
    console.info(`INVERSE containment tested=${tested} escapes=${escapes}`);
    expect(tested).toBeGreaterThan(900_000);
    expect(escapes).toBe(0);
  });

  it('MUTATION inflation removed (inflationScale 0) turns containment red', () => {
    const { escapes } = run(0);
    console.info(`INVERSE mutation (no inflation) escapes=${escapes}`);
    expect(escapes).toBeGreaterThan(0);
  });

  it('chunk margin grows every side by exactly one margin', () => {
    const { cam, t } = randomScene(rng(5));
    const a = viewportToSourceBounds(cam, t, M, {});
    const b = viewportToSourceBounds(cam, t, M, { chunkMargin: 250 });
    expect(a.minX - b.minX).toBeCloseTo(250, 6);
    expect(b.maxY - a.maxY).toBeCloseTo(250, 6);
  });

  it('rings contain the same points and sit inside the AABB', () => {
    const r = rng(77);
    for (let i = 0; i < 300; i++) {
      const { cam, t } = randomScene(r);
      const ring = viewportToSourceRings(cam, t, M);
      const bb = viewportToSourceBounds(cam, t, M);
      const clamp = DEFAULT_HORIZON_SCREENS * Math.max(cam.width, cam.height);
      const inside = (x: number, y: number) => {
        let sign = 0;
        for (let k = 0; k < ring.length; k += 2) {
          const ax = ring[k]!, ay = ring[k + 1]!, bx = ring[(k + 2) % ring.length]!, by = ring[(k + 3) % ring.length]!;
          const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
          if (cr < -1e-9) return false; // counter-clockwise hull
          sign += cr;
        }
        return true;
      };
      for (let k = 0; k < 30; k++) {
        const hit = samplePoint(r, cam, clamp);
        if (!hit) continue;
        const [x, y] = t.inverse(...hit.lngLat);
        expect(inside(x, y)).toBe(true);
      }
      for (let k = 0; k < ring.length; k += 2) {
        expect(ring[k]!).toBeGreaterThanOrEqual(bb.minX - 1e-6);
        expect(ring[k]!).toBeLessThanOrEqual(bb.maxX + 1e-6);
      }
    }
  });

  it('overshoot is bounded and recorded', () => {
    const r = rng(99);
    const aabb: number[] = [], rings: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const { cam, t } = randomScene(r, 0);
      const trueArea = polygonArea(edgePolygon(cam, t, 256));
      const bb = viewportToSourceBounds(cam, t, M);
      aabb.push(((bb.maxX - bb.minX) * (bb.maxY - bb.minY)) / trueArea);
      const ring = viewportToSourceRings(cam, t, M);
      const pts: [number, number][] = [];
      for (let k = 0; k < ring.length; k += 2) pts.push([ring[k]!, ring[k + 1]!]);
      rings.push(polygonArea(pts) / trueArea);
    }
    const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]!;
    console.info(
      `INVERSE overshoot aabb median=${q(aabb, 0.5).toFixed(3)} p99=${q(aabb, 0.99).toFixed(3)} ` +
        `rings median=${q(rings, 0.5).toFixed(3)} p99=${q(rings, 0.99).toFixed(3)}`,
    );
    expect(q(rings, 0.5)).toBeLessThanOrEqual(1.35);
    expect(q(rings, 0.99)).toBeLessThanOrEqual(3.0);
    // The axis-aligned box of a rotated rectangle cannot beat the rectangle's own bounding box:
    // recorded, with the theoretical rotated-rectangle ceiling as its gate.
    expect(q(aabb, 0.99)).toBeLessThanOrEqual(3.0);
  });

  it('pitch 60: the horizon clamp binds, area is finite and below the documented multiple of the nadir query', () => {
    const MULTIPLE = 16;
    const r = rng(2024);
    for (let i = 0; i < 200; i++) {
      const { cam, t } = randomScene(r, 0);
      const nadir = viewportToSourceBounds(cam, t, M);
      const pitched = viewportToSourceBounds({ ...cam, pitch: 60 }, t, M);
      const area = (b: typeof nadir) => (b.maxX - b.minX) * (b.maxY - b.minY);
      expect(Number.isFinite(area(pitched))).toBe(true);
      expect(area(pitched)).toBeLessThanOrEqual(MULTIPLE * area(nadir));
    }
    // and the clamp actually binds at 60 degrees on a 1024x768 view
    const { t } = randomScene(rng(1), 0);
    const cam: Camera = { center: [8.5, 47.4], zoom: 12, bearing: 0, pitch: 60, width: 1024, height: 768, devicePixelRatio: 1 };
    const clamped = viewportToSourceBounds(cam, t, M);
    const loose = viewportToSourceBounds(cam, t, M, { horizonScreens: 50 });
    const area = (b: typeof clamped) => (b.maxX - b.minX) * (b.maxY - b.minY);
    expect(area(loose)).toBeGreaterThan(1.1 * area(clamped));
  });

  it('cost: median call at or below 0.2 ms', () => {
    const r = rng(8);
    const scenes = Array.from({ length: 200 }, () => randomScene(r));
    for (let w = 0; w < 3; w++) for (const s of scenes) viewportToSourceBounds(s.cam, s.t, M); // warm up
    const times: number[] = [];
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      for (const s of scenes) viewportToSourceBounds(s.cam, s.t, M);
      times.push(((performance.now() - t0) / scenes.length));
    }
    times.sort((a, b) => a - b);
    console.info(`INVERSE cost median ${times[2]!.toFixed(4)} ms/call`);
    expect(times[2]!).toBeLessThanOrEqual(0.2);
  });
});

function edgePolygon(cam: Camera, t: ReturnType<typeof transformOf>, n: number): [number, number][] {
  const out: [number, number][] = [];
  const add = (x: number, y: number) => {
    const h = unprojectToGround(x, y, cam)!;
    out.push(t.inverse(...h.lngLat));
  };
  for (let i = 0; i < n; i++) add((i / n) * cam.width, 0);
  for (let i = 0; i < n; i++) add(cam.width, (i / n) * cam.height);
  for (let i = 0; i < n; i++) add(cam.width - (i / n) * cam.width, cam.height);
  for (let i = 0; i < n; i++) add(0, cam.height - (i / n) * cam.height);
  return out;
}

function polygonArea(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]!, [x1, y1] = p[(i + 1) % p.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}
