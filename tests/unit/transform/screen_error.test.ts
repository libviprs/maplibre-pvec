import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISPLAY_FIDELITY_TARGET_PX } from '../../../src/config/defaults';
import { MercatorProjectionAdapter } from '../../../src/transform/projection';
import { type TransformPipeline, chordErrorPx, errorOfTessellation, subdivide } from '../../../src/transform/screen_error';
import { anchoredGeoRef, camera, transformOf } from '../helpers/scene';
import { arc, cubic, ellipse, line, spiral } from '../helpers/curves';

const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/projection-amplified-arc/fixture.json', import.meta.url)), 'utf8'),
);

function pipeline(site: { lng: number; lat: number; anisotropy: number }, dpr = fx.camera.devicePixelRatio): TransformPipeline {
  return {
    transform: transformOf(anchoredGeoRef({ lng: site.lng, lat: site.lat, anisotropy: site.anisotropy })),
    projection: MercatorProjectionAdapter,
    camera: camera({ ...fx.camera, center: [site.lng, site.lat], devicePixelRatio: dpr }),
  };
}

const RAD = Math.PI / 180;
/** Apex sag in metres times screen px per metre along y, from first principles. */
function expectedSagPx(site: { lat: number; anisotropy: number }, dpr = 1): number {
  const sagM = fx.arc.radiusM * (1 - Math.cos(fx.arc.sweepRad / 2));
  const W = 512 * 2 ** fx.camera.zoom;
  const pxPerMetreY = (site.anisotropy * W) / (360 * 110_574) / Math.cos(site.lat * RAD);
  return sagM * pxPerMetreY * dpr;
}

describe('M4.4 projection-amplified-arc', () => {
  const curve = arc(fx.arc.radiusM, fx.arc.sweepRad);

  it('source-space chord error is 0.1 px (fixture precondition)', () => {
    const e = chordErrorPx(curve, 0, 1, pipeline(fx.nominal));
    expect(Math.abs(e - fx.expect.sourceSpacePx) / fx.expect.sourceSpacePx).toBeLessThan(0.1);
  });

  it('reports the post-projection error (> 4 px) to within 10 percent of the analytic value', () => {
    const e = chordErrorPx(curve, 0, 1, pipeline(fx.highLatitude));
    const truth = expectedSagPx(fx.highLatitude);
    expect(e).toBeGreaterThan(fx.expect.postProjectionPxAtLeast);
    expect(Math.abs(e - truth) / truth).toBeLessThan(0.1);
  });

  it('MUTATION evaluating in source space instead of through the pipeline turns the check red', () => {
    const wrong = chordErrorPx(curve, 0, 1, pipeline(fx.nominal)); // source-space evaluation
    const truth = expectedSagPx(fx.highLatitude);
    expect(Math.abs(wrong - truth) / truth).toBeGreaterThan(0.1);
  });

  it('error is in device px: correct at devicePixelRatio 1, 2 and 3', () => {
    for (const dpr of [1, 2, 3]) {
      const e = chordErrorPx(curve, 0, 1, pipeline(fx.highLatitude, dpr));
      const truth = expectedSagPx(fx.highLatitude, dpr);
      expect(Math.abs(e - truth) / truth, `dpr ${dpr}`).toBeLessThan(0.1);
    }
  });
});

describe('M4.4 subdivision meets the budget over 1e4 sampled parameters', () => {
  const site = { lng: 8.5, lat: 60, anisotropy: 3 };
  const families: [string, ReturnType<typeof arc>][] = [
    ['line', line(-50, -20, 80, 40)],
    ['arc', arc(40, 2.2)],
    ['ellipse', ellipse(60, 15, 0.2, 5.5)],
    ['cubic', cubic([[0, 0], [60, 90], [-20, 90], [50, -10]])],
    ['spiral', spiral(3, 2, 40)],
  ];
  for (const dpr of [1, 2, 3]) {
    for (const [name, curve] of families) {
      it(`${name} at dpr ${dpr}`, () => {
        const p = pipeline(site, dpr);
        const r = subdivide(curve, p, DISPLAY_FIDELITY_TARGET_PX);
        expect(r.meetsBudget).toBe(true);
        const measured = errorOfTessellation(r.params, curve, p, 10_000);
        expect(measured).toBeLessThanOrEqual(DISPLAY_FIDELITY_TARGET_PX);
        expect(r.params[0]).toBe(0);
        expect(r.params[r.params.length - 1]).toBe(1);
      });
    }
  }
});

describe('M4.4 depth cap', () => {
  it('returns the residual, flags the result as not meeting budget, never promotes it', () => {
    const wiggle = { domain: [0, 1] as const, point: (t: number): [number, number] => [t * 100, 30 * Math.sin(t * 2000)] };
    const p = pipeline({ lng: 8.5, lat: 45, anisotropy: 1 });
    const r = subdivide(wiggle, p, 0.5, 3);
    expect(r.meetsBudget).toBe(false);
    expect(r.cappedSegments).toBeGreaterThan(0);
    expect(r.errorPx).toBeGreaterThan(0.5);
  });
  it('an unprojectable point yields Infinity, so it is never reported as within budget', () => {
    const p = pipeline({ lng: 8.5, lat: 45, anisotropy: 1 });
    const blind: TransformPipeline = { ...p, projection: { ...p.projection, project: () => [NaN, NaN] } };
    expect(chordErrorPx(line(0, 0, 10, 10), 0, 1, blind)).toBe(Infinity);
    const r = subdivide(line(0, 0, 10, 10), blind, 0.5, 4);
    expect(r.meetsBudget).toBe(false);
  });
});

describe('M4.4 budget ownership', () => {
  it('the pixel target is labelled a display-fidelity budget owned by this repository', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../src/config/defaults.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/display-fidelity budget/i);
    expect(src).toMatch(/P1\.2/);
  });
});
