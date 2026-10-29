import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRECISION_ENVELOPE } from '../../../src/config/defaults';
import { conformanceMayPass, gateProjection } from '../../../src/transform/projection';
import { type CellParams, cellError } from '../helpers/cell';
import type { Scheme } from '../helpers/f32';

/** M4.8 matrix, CPU slice. The GPU/browser slice is in docs/deferred.md. */
const AXES = {
  zoom: [0, 8, 14, 18, 20, 22, 24],
  magnitude: [1e0, 1e3, 1e5, 1e7],
  size: [1e-3, 1e-1, 1e0, 1e2],
  lat: [0, 45, 60, 75, 84],
  rotationDeg: [0, 0.5, 30, 45, 89.9],
  bp: [[0, 0], [45, 0], [0, 45], [135, 60]] as [number, number][],
  dpr: [1, 2, 3],
};
const CELLS = Object.values(AXES).reduce((n, a) => n * a.length, 1);

interface Row extends CellParams { errorPx: number; gated: boolean }

function runMatrix(scheme: Scheme): Row[] {
  const rows: Row[] = [];
  let seed = 1;
  for (const zoom of AXES.zoom) for (const magnitude of AXES.magnitude) for (const size of AXES.size)
    for (const lat of AXES.lat) for (const rotationDeg of AXES.rotationDeg) for (const [bearing, pitch] of AXES.bp)
      for (const dpr of AXES.dpr) {
        const c: CellParams = { zoom, magnitude, size, lat, rotationDeg, bearing, pitch, dpr };
        const gated = zoom <= PRECISION_ENVELOPE.maxZoom && magnitude <= PRECISION_ENVELOPE.maxSourceMagnitude && lat <= PRECISION_ENVELOPE.maxLatitude;
        rows.push({ ...c, errorPx: cellError(c, scheme, seed++), gated });
      }
  return rows;
}

const rows = runMatrix('highlow');

describe('M4.8 precision stress matrix (CPU slice)', () => {
  it('executes and records every cell', () => {
    expect(AXES.zoom).toContain(24);
    expect(rows).toHaveLength(CELLS);
    expect(CELLS).toBe(33_600);
    expect(rows.every((r) => Number.isFinite(r.errorPx))).toBe(true);
  });

  it('inside the gated envelope positional error stays at or below 0.25 device px', () => {
    const gated = rows.filter((r) => r.gated);
    expect(gated.length).toBe(CELLS - CELLS / AXES.zoom.length);
    const worst = gated.reduce((a, b) => (b.errorPx > a.errorPx ? b : a));
    console.info(`STRESS gated cells ${gated.length}, worst ${worst.errorPx.toExponential(2)} px at ${JSON.stringify(worst)}`);
    expect(worst.errorPx).toBeLessThanOrEqual(0.25);
  });

  it('zoom 24 rows are reported outside the v1 envelope and do not gate', () => {
    const z24 = rows.filter((r) => r.zoom === 24);
    expect(z24.length).toBe(CELLS / AXES.zoom.length);
    expect(z24.every((r) => !r.gated)).toBe(true);
    console.info(`STRESS zoom 24 (outside v1 envelope) worst ${Math.max(...z24.map((r) => r.errorPx)).toExponential(2)} px`);
  });

  it('no axis-aligned bias: error distributions at 0 and 89.9 degrees differ by at most 20 percent', () => {
    const mean = (deg: number) => {
      const s = rows.filter((r) => r.gated && r.rotationDeg === deg).map((r) => r.errorPx);
      return s.reduce((a, b) => a + b, 0) / s.length;
    };
    const a = mean(0), b = mean(89.9);
    console.info(`STRESS mean error rot0=${a.toExponential(3)} rot89.9=${b.toExponential(3)}`);
    expect(Math.abs(a - b) / Math.max(a, b)).toBeLessThanOrEqual(0.2);
  });

  it('non-Mercator rows run only with the explicit opt-in and are reported as non-conformant, never as a pass', () => {
    expect(() => gateProjection('globe')).toThrow();
    const gate = gateProjection('globe', { allowUnprovenProjection: true });
    const row = { projection: 'globe', status: conformanceMayPass(gate) ? 'pass' : 'non-conformant' };
    expect(row.status).toBe('non-conformant');
  });

  it('writes bench output when PRECISION_STRESS_OUT is set', () => {
    const out = process.env.PRECISION_STRESS_OUT;
    if (!out) return;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ axes: AXES, cells: rows.length, rows }, null, 1));
  });
});

describe('M4.8 docs/precision.md is generated from the measurement', () => {
  it('the envelope table matches the run', () => {
    const header = '| zoom | naive f32 world (px) | local origin (px) | origin + high/low (px) |\n|---|---|---|---|';
    const table: string[] = [];
    for (const zoom of AXES.zoom) {
      const worst: Record<Scheme, number> = { naive: 0, origin: 0, highlow: 0 };
      let seed = 1;
      for (const size of AXES.size) for (const lat of AXES.lat) for (const rotationDeg of AXES.rotationDeg) for (const [bearing, pitch] of AXES.bp) {
        const c: CellParams = { zoom, magnitude: 1e7, size, lat, rotationDeg, bearing, pitch, dpr: 2, spread: 5e6 };
        for (const s of ['naive', 'origin', 'highlow'] as Scheme[]) worst[s] = Math.max(worst[s], cellError(c, s, seed));
        seed++;
      }
      const f = (v: number) => (v >= 1 ? v.toFixed(1) : v.toExponential(1));
      table.push(`| ${zoom}${zoom > PRECISION_ENVELOPE.maxZoom ? ' (outside v1)' : ''} | ${f(worst.naive)} | ${f(worst.origin)} | ${f(worst.highlow)} |`);
    }
    const generated = `${header}\n${table.join('\n')}`;
    console.info(`PRECISION-TABLE\n${generated}`);
    const doc = readFileSync(fileURLToPath(new URL('../../../docs/precision.md', import.meta.url)), 'utf8');
    const m = doc.match(/<!-- precision-table:start -->\n([\s\S]*?)\n<!-- precision-table:end -->/);
    expect(m, 'docs/precision.md needs the precision-table markers').not.toBeNull();
    expect(m![1]).toBe(generated);
  });
});
