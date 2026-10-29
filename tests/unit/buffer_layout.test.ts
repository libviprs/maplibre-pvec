import { describe, expect, it } from 'vitest';
import { SEGMENT_RECORD_BYTES, decodeRecord, packFlags, packPolyline, splitHiLo, unpackFlags } from '../../src/render/buffer_layout';

describe('buffer layout (#50 M5.2)', () => {
  it('records are 40 bytes and 1e6 segments fit in 40 MiB', () => {
    expect(SEGMENT_RECORD_BYTES).toBe(40);
    expect(1_000_000 * SEGMENT_RECORD_BYTES).toBeLessThanOrEqual(40 * 1024 * 1024 * (1_000_000 / 1_048_576) + 1);
    expect(1_048_576 * SEGMENT_RECORD_BYTES).toBeLessThanOrEqual(40 * 1024 * 1024);
    const r = packPolyline(Float64Array.of(0, 0, 3, 4), { widthIndex: 1, dashIndex: 0, flags: 0 });
    expect(r.data.byteLength).toBe(40);
  });

  it('hi + lo recovers the f64 coordinate far better than a single f32', () => {
    const v = 6_378_137.123456789;
    const { hi, lo } = splitHiLo(v);
    expect(Math.abs(hi + lo - v)).toBeLessThan(1e-6);
    expect(Math.abs(Math.fround(v) - v)).toBeGreaterThan(1e-3);
  });

  it('never uploads a world coordinate as one f32: low word is non-zero for large fixtures', () => {
    const big = Float64Array.of(4_000_000.37, 5_000_000.91, 4_000_100.41, 5_000_050.13);
    const { data, count } = packPolyline(big, { widthIndex: 0, dashIndex: 0, flags: 0 });
    expect(count).toBe(1);
    const rec = decodeRecord(data, 0);
    expect(rec.p0.xLo).not.toBe(0);
    expect(rec.p0.yLo).not.toBe(0);
    expect(rec.p1.xLo).not.toBe(0);
    expect(rec.p0.xHi + rec.p0.xLo).toBeCloseTo(4_000_000.37, 6);
  });

  it('carries cumulative arc length at segment start', () => {
    const { data } = packPolyline(Float64Array.of(0, 0, 3, 4, 3, 14, 3, 14), { widthIndex: 0, dashIndex: 0, flags: 0 });
    expect(decodeRecord(data, 0).arc).toBe(0);
    expect(decodeRecord(data, 1).arc).toBeCloseTo(5, 6);
  });

  it('drops and counts degenerate segments exactly', () => {
    const pts = Float64Array.of(0, 0, 0, 0, 1, 0, NaN, 3, 4, 4, Infinity, 1, 5, 5, 5, 5);
    const r = packPolyline(pts, { widthIndex: 0, dashIndex: 0, flags: 0 });
    expect(r.degenerate).toBe(6);
    expect(r.count).toBe(1);
    expect(r.count + r.degenerate).toBe(7);
  });

  it('packs width, dash and flags losslessly into one u32', () => {
    const m = packFlags({ widthIndex: 4095, dashIndex: 17, flags: 0xa5 });
    expect(unpackFlags(m)).toEqual({ widthIndex: 4095, dashIndex: 17, flags: 0xa5 });
    expect(() => packFlags({ widthIndex: 4096, dashIndex: 0, flags: 0 })).toThrow();
  });
});
