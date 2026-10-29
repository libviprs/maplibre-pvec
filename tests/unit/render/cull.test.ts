import { describe, expect, it } from 'vitest';
import { type CullableEntity, conservativeScreenBounds, isEntityVisible, visibleBlocks } from '../../../src/render/cull';
import { MercatorProjectionAdapter } from '../../../src/transform/projection';
import { type TransformPipeline, sourceToDevicePx } from '../../../src/transform/screen_error';
import { anchoredGeoRef, camera, transformOf } from '../helpers/scene';
import { arc, cubic, ellipse, line } from '../helpers/curves';
import { expectNeverCulled, falseCulls } from '../helpers/cull';
import { rng } from '../helpers/rng';

const SITE = { lng: 8.5, lat: 47.4 };

function pipelineAt(r: () => number, zoom: [number, number], rotate = true, pan = 200): TransformPipeline {
  const g = anchoredGeoRef({ ...SITE, rotationDeg: rotate ? r() * 360 : 0, anisotropy: 0.8 + r() * 0.4 });
  const t = transformOf(g);
  // camera centre displaced from the entity by up to `pan` metres, random orientation
  const center = t.forward((r() * 2 - 1) * pan, (r() * 2 - 1) * pan);
  return {
    transform: t,
    projection: MercatorProjectionAdapter,
    camera: camera({
      center, zoom: zoom[0] + r() * (zoom[1] - zoom[0]), bearing: r() * 360, pitch: r() * 60,
      width: 640 + Math.floor(r() * 640), height: 480 + Math.floor(r() * 400), devicePixelRatio: [1, 2, 3][Math.floor(r() * 3)]!,
    }),
  };
}

const wrap = (c: { domain: readonly [number, number]; point(t: number): [number, number] }, breakParams: number[], strokeWidthPx = 4): CullableEntity => ({
  domain: c.domain, point: c.point, breakParams, strokeWidthPx,
});

/** Bulge fixture: chord 100, midpoint 40 off the chord (40 percent), apex is the only break. */
const R = (2500 + 1600) / 80;
const sweep = 2 * Math.asin(50 / R);
const bulge = wrap(arc(R, sweep), [0.5]);

describe('M4.7 bulge fixture', () => {
  it('the apex leaves the endpoint bounding box by at least 30 percent of the chord', () => {
    const [ax, ay] = bulge.point(0), [bx, by] = bulge.point(1), [mx, my] = bulge.point(0.5);
    const chord = Math.hypot(bx - ax, by - ay);
    const dist = Math.abs(my - Math.max(ay, by)); // endpoints share a y: the box is the chord itself
    expect(chord).toBeCloseTo(100, 6);
    expect(dist / chord).toBeGreaterThanOrEqual(0.3);
    expect(Math.abs(mx)).toBeLessThan(1e-9);
  });

  const r = rng(500);
  // 600 cameras, many placed to see the apex and not the chord
  const cams = Array.from({ length: 600 }, () => pipelineAt(r, [16, 21], true, 60));

  it('is not culled at any of 500+ sampled cameras (bearing and pitch included)', () => {
    const visible = expectNeverCulled(bulge, cams);
    expect(visible).toBeGreaterThanOrEqual(300);
  });

  it('MUTATION endpoint bounding box instead of analytic extrema turns it red', () => {
    const endpointOnly = wrap(arc(R, sweep), []);
    expect(falseCulls(endpointOnly, cams, { subdivisionsPerPiece: 1 })).toBeGreaterThan(0);
    expect(falseCulls(bulge, cams)).toBe(0);
  });
});

describe('M4.7 zero false culls over the known-truth corpus, 500 cameras each', () => {
  // x' = 0 roots of a cubic Bezier component, via the derivative quadratic
  const bezierBreaks = (p: [number, number][]) => {
    const out: number[] = [];
    for (const k of [0, 1]) {
      const a = 3 * (-p[0]![k]! + 3 * p[1]![k]! - 3 * p[2]![k]! + p[3]![k]!);
      const b = 6 * (p[0]![k]! - 2 * p[1]![k]! + p[2]![k]!);
      const c = 3 * (p[1]![k]! - p[0]![k]!);
      const disc = b * b - 4 * a * c;
      if (Math.abs(a) < 1e-12) { if (b !== 0) out.push(-c / b); continue; }
      if (disc >= 0) for (const s of [-1, 1]) out.push((-b + s * Math.sqrt(disc)) / (2 * a));
    }
    return out.filter((t) => t > 0 && t < 1);
  };
  const cp: [number, number][] = [[0, 0], [60, 90], [-20, 90], [50, -10]];
  const corpus: [string, CullableEntity][] = [
    ['line', wrap(line(-40, -10, 60, 35), [])],
    ['arc', wrap(arc(40, 2.2), [0.5])],
    ['ellipse', wrap(ellipse(60, 15, 0.2, 5.5), [(Math.PI / 2 - 0.2) / 5.3, (Math.PI - 0.2) / 5.3, (1.5 * Math.PI - 0.2) / 5.3, (2 * Math.PI - 0.2) / 5.3].filter((t) => t > 0 && t < 1))],
    ['cubic', wrap(cubic(cp), bezierBreaks(cp))],
  ];
  const r = rng(77);
  const cams = Array.from({ length: 500 }, () => pipelineAt(r, [15, 21], true, 80));
  for (const [name, e] of corpus) {
    it(name, () => {
      expect(expectNeverCulled(e, cams)).toBeGreaterThan(50);
    });
  }

  it('conservatism: mean conservative area is at most 1.25x the exact transformed bounds', () => {
    const ratios: number[] = [];
    for (const [name, e] of corpus) {
      if (name === 'line') continue; // a thin line has near-zero exact area; covered by the false-cull test
      const mine: number[] = [];
      const flat: CullableEntity = { ...e, strokeWidthPx: 0 };
      for (const p of cams.slice(0, 250)) {
        const b = conservativeScreenBounds(flat, p, { featherPx: 0 });
        if (!b) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i <= 4000; i++) {
          const [x, y] = sourceToDevicePx(p, ...e.point(e.domain[0] + ((e.domain[1] - e.domain[0]) * i) / 4000));
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        // only entities that reach the viewport matter: off-screen ones are culled either way
        const vw = p.camera.width * p.camera.devicePixelRatio, vh = p.camera.height * p.camera.devicePixelRatio;
        if (x1 < 0 || x0 > vw || y1 < 0 || y0 > vh) continue;
        const exact = Math.max(x1 - x0, 1) * Math.max(y1 - y0, 1);
        ratios.push(((b.maxX - b.minX) * (b.maxY - b.minY)) / exact);
        mine.push(ratios[ratios.length - 1]!);
      }
      console.info(`CULL ${name} mean ${(mine.reduce((a, b) => a + b, 0) / mine.length).toFixed(3)} max ${Math.max(...mine).toFixed(2)}`);
    }
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    console.info(`CULL conservatism mean ${mean.toFixed(3)} over ${ratios.length} (curve, camera) pairs`);
    expect(mean).toBeLessThanOrEqual(1.25);
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0.999);
  });
});

describe('M4.7 stroke width and feather', () => {
  it('a 20 px line whose centreline is off-screen still draws while its edge is visible', () => {
    const r = rng(3);
    const p: TransformPipeline = { ...pipelineAt(r, [18, 18], false, 0), };
    const cam = { ...p.camera, bearing: 0, pitch: 0, devicePixelRatio: 1, width: 800, height: 600 };
    const pp = { ...p, camera: cam };
    // a horizontal line (in screen space) whose centre is 6 px above the top edge
    const fromScreen = (sx: number, sy: number) => {
      const lngLat = unproject(pp, sx, sy);
      return pp.transform.inverse(...lngLat);
    };
    const a = fromScreen(-100, -6), b = fromScreen(900, -6);
    const wide = wrap(line(a[0], a[1], b[0], b[1]), [], 20);
    const hairline = wrap(line(a[0], a[1], b[0], b[1]), [], 0);
    expect(isEntityVisible(wide, pp)).toBe(true);
    expect(isEntityVisible(hairline, pp, { featherPx: 0 })).toBe(false);
  });
});

describe('M4.7 hierarchical culling', () => {
  it('block bounds are tested against the source-space query first', () => {
    const q = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const blocks = [
      { id: 1, aabb: { minX: 5, minY: 5, maxX: 20, maxY: 20 } },
      { id: 2, aabb: { minX: 11, minY: 0, maxX: 20, maxY: 5 } },
    ];
    expect(visibleBlocks(blocks, q).map((b) => b.id)).toEqual([1]);
  });
});

import { unprojectToGround } from '../../../src/transform/projection';
function unproject(p: TransformPipeline, sx: number, sy: number): [number, number] {
  return unprojectToGround(sx, sy, p.camera)!.lngLat;
}
