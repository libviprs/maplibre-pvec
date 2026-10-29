/**
 * Per-segment instance record, 40 bytes (see docs/buffer-model.md):
 *   f32 x0_hi, y0_hi, x0_lo, y0_lo   endpoint 0 (16 B)
 *   f32 x1_hi, y1_hi, x1_lo, y1_lo   endpoint 1 (16 B)
 *   f32 arc                          cumulative arc length at segment start (4 B)
 *   u32 meta                         widthIndex:12 | dashIndex:12 | flags:8 (4 B)
 */
export const SEGMENT_RECORD_BYTES = 40;

export interface SegmentMeta { widthIndex: number; dashIndex: number; flags: number }

/** Split an f64 into two f32 words whose sum recovers it to about 2^-47 relative. */
export function splitHiLo(v: number): { hi: number; lo: number } {
  const hi = Math.fround(v);
  return { hi, lo: Math.fround(v - hi) };
}

export function packFlags(m: SegmentMeta): number {
  if (!(m.widthIndex >= 0 && m.widthIndex < 4096)) throw new RangeError('widthIndex must be 0..4095');
  if (!(m.dashIndex >= 0 && m.dashIndex < 4096)) throw new RangeError('dashIndex must be 0..4095');
  if (!(m.flags >= 0 && m.flags < 256)) throw new RangeError('flags must be 0..255');
  return ((m.widthIndex | (m.dashIndex << 12) | (m.flags << 24)) >>> 0);
}

export function unpackFlags(u: number): SegmentMeta {
  return { widthIndex: u & 0xfff, dashIndex: (u >>> 12) & 0xfff, flags: u >>> 24 };
}

export interface PackResult {
  data: ArrayBuffer;
  /** Records written. */
  count: number;
  /** Segments dropped for zero length or non-finite endpoints. */
  degenerate: number;
}

/** Pack the consecutive point pairs of a polyline (x,y,x,y,...) into segment records. */
export function packPolyline(points: ArrayLike<number>, meta: SegmentMeta): PackResult {
  const n = Math.floor(points.length / 2) - 1;
  const packedMeta = packFlags(meta);
  const out = new ArrayBuffer(Math.max(n, 0) * SEGMENT_RECORD_BYTES);
  const dv = new DataView(out);
  let count = 0, degenerate = 0, arc = 0;
  for (let i = 0; i < n; i++) {
    const x0 = points[2 * i]!, y0 = points[2 * i + 1]!, x1 = points[2 * i + 2]!, y1 = points[2 * i + 3]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!Number.isFinite(x0 + y0 + x1 + y1) || !(len > 0)) { degenerate++; continue; }
    const o = count * SEGMENT_RECORD_BYTES;
    const a = [splitHiLo(x0), splitHiLo(y0), splitHiLo(x1), splitHiLo(y1)];
    dv.setFloat32(o, a[0]!.hi, true); dv.setFloat32(o + 4, a[1]!.hi, true);
    dv.setFloat32(o + 8, a[0]!.lo, true); dv.setFloat32(o + 12, a[1]!.lo, true);
    dv.setFloat32(o + 16, a[2]!.hi, true); dv.setFloat32(o + 20, a[3]!.hi, true);
    dv.setFloat32(o + 24, a[2]!.lo, true); dv.setFloat32(o + 28, a[3]!.lo, true);
    dv.setFloat32(o + 32, arc, true);
    dv.setUint32(o + 36, packedMeta, true);
    arc += len;
    count++;
  }
  return { data: out.slice(0, count * SEGMENT_RECORD_BYTES), count, degenerate };
}

export interface DecodedRecord {
  p0: { xHi: number; yHi: number; xLo: number; yLo: number };
  p1: { xHi: number; yHi: number; xLo: number; yLo: number };
  arc: number;
  meta: SegmentMeta;
}

export function decodeRecord(data: ArrayBuffer, index: number): DecodedRecord {
  const dv = new DataView(data);
  const o = index * SEGMENT_RECORD_BYTES;
  const f = (k: number) => dv.getFloat32(o + k, true);
  return {
    p0: { xHi: f(0), yHi: f(4), xLo: f(8), yLo: f(12) },
    p1: { xHi: f(16), yHi: f(20), xLo: f(24), yLo: f(28) },
    arc: f(32),
    meta: unpackFlags(dv.getUint32(o + 36, true)),
  };
}
