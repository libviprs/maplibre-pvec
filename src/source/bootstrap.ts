import { PVecCapabilityError, PVecFormatError } from "./errors";
import type { PVecBounds, PVecChunk, PVecSource } from "./PVecSource";
import { classifyVersion, type VersionIdentity } from "./version";

/*
 * Container layout parsing only (CONTAINER.md chapters 1, 4 and 5). Geometry semantics are not
 * read here: they come from the shared PVec evaluator compiled to WASM. Once that artifact is
 * released this prefix parser should be replaced by the WASM reader's, see docs/deferred.md.
 */

/** The cold open reads this much first: the header and, in every file the writer produces, the manifest. */
export const PREFIX_BYTES = 4096;
/** Bootstrap ceiling: prefix, one more request when the manifest overflows it, and the directory. */
export const BOOTSTRAP_MAX_REQUESTS = 3;
const MAX_MANIFEST = 1 << 20;
/** LIMIT-06, browser preset. */
const MAX_BLOCKS = 131072;
const MAGIC = [0x89, 0x50, 0x56, 0x45, 0x43, 0x0d, 0x0a, 0x1a];

/** Capability registry names (CAPABILITIES.md). */
const NAMES: Record<number, string> = {
  1: "cartesian_point", 2: "direction_vector", 3: "axis_placement_2d", 4: "line", 5: "polyline",
  6: "circle", 7: "ellipse", 8: "trimmed_curve", 9: "composite_curve", 10: "bezier_curve",
  11: "b_spline_curve", 12: "rational_b_spline_curve", 13: "affine_transform_2d", 14: "layer",
  15: "line_style", 16: "text", 17: "hatch", 18: "source_provenance", 19: "dwg_semantics", 20: "semantic_class",
};
const nameOf = (id: number): string => NAMES[id] ?? `capability#${id}`;
/** The capabilities this add-on can draw: the geometry set at major 1. Components load independently later. */
const SUPPORTED_MAJOR: Record<number, number> = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, 1]));
const READER_VERSION: [number, number, number] = [1, 0, 0];

export interface ManifestCapability {
  id: number;
  name: string;
  major: number;
  minor: number;
  patch: number;
  required: boolean;
}
export interface PVecManifest {
  lengthUnit: number;
  metresPerUnit: number;
  sourceBounds: PVecBounds;
  minReader: [number, number, number];
  capabilities: ManifestCapability[];
  producer: string;
}
export interface DirectoryEntry extends PVecChunk {
  uncompressedLength: number;
  count: number;
  subtype: number;
  codec: number;
  capability: number;
  mustUnderstand: boolean;
  /** An optional block of a kind this reader does not know: kept, never fetched. */
  skipped: boolean;
  hasBounds: boolean;
}
export interface BlockDirectory {
  entries: DirectoryEntry[];
  query(bounds: PVecBounds): PVecChunk[];
}
export interface PVecHandle {
  manifest: PVecManifest;
  directory: BlockDirectory;
  /** Present when the file carries a spatial directory (kind 3); its decoding belongs to the WASM reader. */
  spatialDirectory: { offset: number; length: number } | undefined;
  version: VersionIdentity;
  artifactLength: number;
  requestCount: number;
  byteCount: number;
  report: { unsupportedOptional: { id: number; name: string }[]; skippedBlocks: number[] };
}

const fail = (code: string, message: string): never => {
  throw new PVecFormatError(code, message);
};

export async function bootstrap(source: PVecSource): Promise<PVecHandle> {
  const requests0 = source.stats.requests;
  const bytes0 = source.stats.bytes;
  const prefix = await source.readRange(0, PREFIX_BYTES);
  const total = source.artifactLength ?? fail("no-length", "the origin did not report the artifact length");
  const hdr = parseHeader(prefix, total);
  // Pin before any further request so every later range carries the identity.
  const version = classifyVersion(source.options.url, source.lastEtag);
  source.pinVersion(version);

  const manifestBytes =
    hdr.manifestOffset + hdr.manifestLength <= prefix.length
      ? prefix.subarray(hdr.manifestOffset, hdr.manifestOffset + hdr.manifestLength)
      : await source.readRange(hdr.manifestOffset, hdr.manifestLength);
  const { manifest, pointers } = parseManifest(manifestBytes, hdr, total);

  const unsupportedOptional = negotiate(manifest);

  const dir = pointers.find((p) => p.kind === 1) ?? fail("no-block-directory", "the manifest has no block directory pointer");
  if (dir.length % 64 !== 0) fail("directory-misaligned", `block directory length ${dir.length} is not a multiple of 64`);
  if (dir.length / 64 > MAX_BLOCKS) fail("limit-blocks", `${dir.length / 64} blocks passes the ceiling of ${MAX_BLOCKS}`);
  const dirBytes = await source.readRange(dir.offset, dir.length);
  if (dirBytes.length !== dir.length) fail("directory-short", "the block directory came back short");
  const { directory, skippedBlocks } = parseDirectory(dirBytes, hdr.headerLen, total);

  const spatial = pointers.find((p) => p.kind === 3);
  return {
    manifest,
    directory,
    spatialDirectory: spatial && { offset: spatial.offset, length: spatial.length },
    version,
    artifactLength: total,
    requestCount: source.stats.requests - requests0,
    byteCount: source.stats.bytes - bytes0,
    report: { unsupportedOptional, skippedBlocks },
  };
}

interface Header {
  headerLen: number;
  manifestOffset: number;
  manifestLength: number;
}

function parseHeader(b: Uint8Array, total: number): Header {
  if (b.length < 64) fail("short-header", `only ${b.length} bytes, a header is at least 64`);
  if (!MAGIC.every((m, i) => b[i] === m)) fail("bad-magic", "not a PVec container");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(8, true) !== 1) fail("unsupported-version", `container major ${dv.getUint16(8, true)} is not implemented`);
  if (dv.getUint32(12, true) !== 0x01020304) fail("bad-byte-order", "byte order marker is wrong");
  const headerLen = dv.getUint16(16, true);
  if (headerLen < 64 || headerLen > 4096) fail("bad-header-length", `header_len ${headerLen}`);
  const manifestOffset = dv.getBigUint64(24, true);
  const manifestLength = dv.getBigUint64(32, true);
  const t = BigInt(total);
  if (manifestOffset < BigInt(headerLen) || manifestLength < 1n || manifestLength > BigInt(MAX_MANIFEST) || manifestOffset + manifestLength > t) {
    fail("pointer-out-of-range", `manifest ${manifestOffset}+${manifestLength} against a file of ${total} bytes`);
  }
  return { headerLen, manifestOffset: Number(manifestOffset), manifestLength: Number(manifestLength) };
}

interface Pointer {
  kind: number;
  offset: number;
  length: number;
}

function parseManifest(b: Uint8Array, hdr: Header, total: number): { manifest: PVecManifest; pointers: Pointer[] } {
  if (b.length < 128) fail("manifest-truncated", "manifest is shorter than its fixed part");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const capCount = dv.getUint32(4, true);
  const dirCount = dv.getUint32(56, true);
  const tail = 128 + 16 * capCount + 24 * dirCount;
  if (tail > b.length) fail("manifest-truncated", "capability and directory tables run past the manifest");
  const f = (o: number): number => dv.getFloat64(o, true);
  const bounds = { minX: f(16), minY: f(24), maxX: f(32), maxY: f(40) };
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) || bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
    fail("bad-bounds", "source bounds are not finite and ordered");
  }
  const capabilities: ManifestCapability[] = [];
  for (let i = 0; i < capCount; i++) {
    const o = 128 + i * 16;
    const id = dv.getUint32(o, true);
    capabilities.push({
      id,
      name: nameOf(id),
      major: dv.getUint16(o + 4, true),
      minor: dv.getUint16(o + 6, true),
      patch: dv.getUint16(o + 8, true),
      required: dv.getUint8(o + 10) === 1,
    });
  }
  const pointers: Pointer[] = [];
  const mEnd = hdr.manifestOffset + hdr.manifestLength;
  for (let i = 0; i < dirCount; i++) {
    const o = 128 + 16 * capCount + i * 24;
    const offset = dv.getBigUint64(o + 8, true);
    const length = dv.getBigUint64(o + 16, true);
    if (offset < BigInt(hdr.headerLen) || offset + length > BigInt(total)) {
      fail("pointer-out-of-range", `directory ${offset}+${length} against a file of ${total} bytes`);
    }
    if (offset < BigInt(mEnd) && offset + length > BigInt(hdr.manifestOffset)) fail("directory-overlaps-manifest", "a directory overlaps the manifest");
    pointers.push({ kind: dv.getUint32(o, true), offset: Number(offset), length: Number(length) });
  }
  const idLen = dv.getUint32(112, true);
  const producer = new TextDecoder().decode(b.subarray(tail, Math.min(b.length, tail + idLen)));
  return {
    manifest: {
      lengthUnit: dv.getUint16(0, true),
      metresPerUnit: f(8),
      sourceBounds: bounds,
      minReader: [dv.getUint16(48, true), dv.getUint16(50, true), dv.getUint16(52, true)],
      capabilities,
      producer,
    },
    pointers,
  };
}

/** Throws before any payload is requested; returns the optional capabilities that are not drawn. */
function negotiate(m: PVecManifest): { id: number; name: string }[] {
  const [a, b, c] = m.minReader;
  const [x, y, z] = READER_VERSION;
  if (a > x || (a === x && (b > y || (b === y && c > z)))) {
    throw new PVecCapabilityError("reader-too-old", `min reader ${a}.${b}.${c}`, `the file needs reader ${a}.${b}.${c}, this is ${x}.${y}.${z}`);
  }
  const unsupportedOptional: { id: number; name: string }[] = [];
  for (const cap of m.capabilities) {
    const supported = SUPPORTED_MAJOR[cap.id] === cap.major;
    if (supported) continue;
    if (cap.required) {
      const known = SUPPORTED_MAJOR[cap.id] !== undefined;
      throw new PVecCapabilityError(
        known ? "required-version" : "required-unsupported",
        cap.name,
        known
          ? `required capability ${cap.name} is declared at major ${cap.major}, this reader implements major ${SUPPORTED_MAJOR[cap.id]}`
          : `required capability ${cap.name} is not supported`,
      );
    }
    unsupportedOptional.push({ id: cap.id, name: cap.name });
  }
  return unsupportedOptional;
}

const KNOWN_KINDS = new Set([1, 2, 3, 4]);

function parseDirectory(b: Uint8Array, headerLen: number, total: number): { directory: BlockDirectory; skippedBlocks: number[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const entries: DirectoryEntry[] = [];
  const skippedBlocks: number[] = [];
  let prevEnd = headerLen;
  for (let i = 0; i < b.length / 64; i++) {
    const o = i * 64;
    const offset = dv.getBigUint64(o, true);
    const length = dv.getUint32(o + 8, true);
    if (offset < BigInt(prevEnd) || offset + BigInt(length) > BigInt(total) || offset % 8n !== 0n) {
      fail("block-out-of-range", `block ${i} at ${offset}+${length} is misplaced in a file of ${total} bytes`);
    }
    prevEnd = Number(offset) + length;
    const flags = dv.getUint8(o + 60);
    const kind = dv.getUint16(o + 56, true);
    const mustUnderstand = (flags & 1) !== 0;
    const hasBounds = (flags & 2) !== 0;
    const skipped = !KNOWN_KINDS.has(kind);
    if (skipped && mustUnderstand) fail("unknown-must-understand-block", `block ${i} has kind ${kind} and must be understood`);
    if (skipped) skippedBlocks.push(i);
    const bounds = hasBounds
      ? { minX: dv.getFloat64(o + 24, true), minY: dv.getFloat64(o + 32, true), maxX: dv.getFloat64(o + 40, true), maxY: dv.getFloat64(o + 48, true) }
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    entries.push({
      index: i,
      cell: dv.getUint32(o + 20, true),
      offset: Number(offset),
      length,
      uncompressedLength: dv.getUint32(o + 12, true),
      count: dv.getUint32(o + 16, true),
      bounds,
      kind,
      subtype: dv.getUint16(o + 58, true),
      codec: dv.getUint8(o + 61),
      capability: dv.getUint16(o + 62, true),
      mustUnderstand,
      skipped,
      hasBounds,
    });
  }
  const query = (q: PVecBounds): PVecChunk[] =>
    entries
      .filter(
        (e) =>
          e.hasBounds && !e.skipped &&
          e.bounds.minX <= q.maxX && e.bounds.maxX >= q.minX && e.bounds.minY <= q.maxY && e.bounds.maxY >= q.minY,
      )
      .sort((a, b) => a.cell - b.cell || a.offset - b.offset);
  return { directory: { entries, query }, skippedBlocks };
}
