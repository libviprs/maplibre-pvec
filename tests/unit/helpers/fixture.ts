/**
 * Builds a small but structurally valid .pvec container (CONTAINER.md chapters 1 and 4):
 * 64 byte header, manifest at 64, blocks, block directory last. Block payloads are marker
 * bytes, because the source never decodes them.
 */
export interface FixtureBlock {
  kind?: number; // 1 hot, 2 records, 3 arena, 4 components
  cell: number;
  bounds?: [number, number, number, number];
  size: number;
  mustUnderstand?: boolean;
  capability?: number;
}
export interface FixtureCapability {
  id: number;
  major?: number;
  required?: boolean;
}
export interface FixtureSpec {
  blocks: FixtureBlock[];
  capabilities?: FixtureCapability[];
  marker?: number;
  sourceBounds?: [number, number, number, number];
  minReader?: [number, number, number];
  /** Added to manifest_offset so tests can make the pointer lie. */
  manifestOffsetLie?: number;
  padManifestTo?: number;
}
export interface BuiltFixture {
  bytes: Uint8Array;
  directoryOffset: number;
  directoryLength: number;
  blockOffsets: number[];
}

const align8 = (n: number): number => (n + 7) & ~7;

export function buildPvec(spec: FixtureSpec): BuiltFixture {
  const caps: FixtureCapability[] = spec.capabilities ?? [1, 4, 5, 6].map((id) => ({ id }));
  const marker = spec.marker ?? 0xaa;
  const producer = new TextEncoder().encode("fixture");
  const manifestFixed = 128;
  const manifestLen = align8(manifestFixed + caps.length * 16 + 24 + producer.length);
  const manifestOffset = 64;
  let cursor = align8(manifestOffset + manifestLen);
  const blockOffsets: number[] = [];
  for (const b of spec.blocks) {
    blockOffsets.push(cursor);
    cursor = align8(cursor + b.size);
  }
  const directoryOffset = cursor;
  const directoryLength = spec.blocks.length * 64;
  const total = directoryOffset + directoryLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x56, 0x45, 0x43, 0x0d, 0x0a, 0x1a], 0);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 0, true);
  dv.setUint32(12, 0x01020304, true);
  dv.setUint16(16, 64, true);
  dv.setUint8(20, 1);
  dv.setUint8(21, 1);
  dv.setBigUint64(24, BigInt(manifestOffset + (spec.manifestOffsetLie ?? 0)), true);
  dv.setBigUint64(32, BigInt(manifestLen), true);
  const dirTable = manifestOffset + manifestFixed + 16 * caps.length;
  dv.setBigUint64(40, BigInt(dirTable), true);
  dv.setBigUint64(48, 24n, true);
  const m = manifestOffset;
  dv.setUint16(m + 0, 1, true); // metres
  dv.setUint32(m + 4, caps.length, true);
  dv.setFloat64(m + 8, 1, true);
  const sb = spec.sourceBounds ?? [0, 0, 1000, 1000];
  sb.forEach((v, i) => dv.setFloat64(m + 16 + i * 8, v, true));
  const mr = spec.minReader ?? [1, 0, 0];
  mr.forEach((v, i) => dv.setUint16(m + 48 + i * 2, v, true));
  dv.setUint32(m + 56, 1, true);
  dv.setUint32(m + 112, producer.length, true);
  caps.forEach((c, i) => {
    const o = m + manifestFixed + i * 16;
    dv.setUint32(o, c.id, true);
    dv.setUint16(o + 4, c.major ?? 1, true);
    dv.setUint8(o + 10, c.required === false ? 2 : 1);
  });
  dv.setUint32(dirTable, 1, true);
  dv.setBigUint64(dirTable + 8, BigInt(directoryOffset), true);
  dv.setBigUint64(dirTable + 16, BigInt(directoryLength), true);
  out.set(producer, dirTable + 24);
  spec.blocks.forEach((b, i) => {
    out.fill(marker, blockOffsets[i]!, blockOffsets[i]! + b.size);
    const o = directoryOffset + i * 64;
    dv.setBigUint64(o, BigInt(blockOffsets[i]!), true);
    dv.setUint32(o + 8, b.size, true);
    dv.setUint32(o + 12, b.size, true);
    dv.setUint32(o + 16, 1, true);
    dv.setUint32(o + 20, b.cell, true);
    if (b.bounds) b.bounds.forEach((v, k) => dv.setFloat64(o + 24 + k * 8, v, true));
    dv.setUint16(o + 56, b.kind ?? 1, true);
    dv.setUint16(o + 58, (b.kind ?? 1) === 1 ? 1 : 0, true);
    dv.setUint8(o + 60, (b.mustUnderstand === false ? 0 : 1) | (b.bounds ? 2 : 0));
    dv.setUint16(o + 62, b.capability ?? 0, true);
  });
  return { bytes: out, directoryOffset, directoryLength, blockOffsets };
}

/** A grid of hot blocks, 4x4 cells over 1000 x 1000 source units. */
export function gridSpec(extra: Partial<FixtureSpec> = {}): FixtureSpec {
  const blocks: FixtureBlock[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      blocks.push({
        cell: r * 4 + c,
        bounds: [c * 250, r * 250, c * 250 + 250, r * 250 + 250],
        size: 2048,
      });
    }
  }
  return { blocks, ...extra };
}
