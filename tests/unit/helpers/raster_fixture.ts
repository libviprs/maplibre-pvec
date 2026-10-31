import { deflateSync } from "node:zlib";
import type { Mat6, RasterPlacement } from "../../../src/render/raster/geometry";

// Raster fixtures for issue 102: a synthetic pyramid of an asymmetric picture, cut into padded tiles and encoded as PNG,
// 1-bit PNG or JPEG. Stands in for pvec's test-only tiler (libviprs/pvec#218) until the real exports exist. No image
// library: PNG is zlib plus CRC, and the JPEG is a baseline gray stream whose 8x8 blocks carry a DC coefficient only, which
// every decoder reproduces to within one level (so the browser's pixels equal the picture's).

export type Kind = "png" | "png1" | "jpeg";
type Rgba = Uint8Array; // width * height * 4

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...a: Uint8Array[]): Uint8Array => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of a) (o.set(x, at), (at += x.length));
  return o;
};
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const t = new TextEncoder().encode(type);
  return cat(be32(data.length), t, data, be32(crc32(cat(t, data))));
};
const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function encodePng(w: number, h: number, rgba: Rgba): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  return cat(SIG, chunk("IHDR", cat(be32(w), be32(h), new Uint8Array([8, 6, 0, 0, 0]))), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()));
}

/** 1-bit grayscale PNG: a pixel is white when its red channel is 128 or more. */
export function encodePng1(w: number, h: number, rgba: Rgba): Uint8Array {
  const stride = Math.ceil(w / 8);
  const raw = new Uint8Array(h * (1 + stride));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4]! >= 128) raw[y * (1 + stride) + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
  return cat(SIG, chunk("IHDR", cat(be32(w), be32(h), new Uint8Array([1, 0, 0, 0, 0]))), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()));
}

/** Baseline gray JPEG, DC only. Width and height are multiples of 8; each 8x8 block takes the red value of its first pixel. */
export function encodeJpeg(w: number, h: number, rgba: Rgba): Uint8Array {
  const marker = (m: number, body: number[]) => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  const dcCounts = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const dcValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const codes = ["00", "010", "011", "100", "101", "110", "1110", "11110", "111110", "1111110", "11111110", "111111110"];
  const bits: string[] = [];
  let prev = 0;
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      const dc = rgba[(by * w + bx) * 4]! - 128; // quantiser 8 and the 8x DC gain cancel
      const d = dc - prev;
      prev = dc;
      const n = d === 0 ? 0 : Math.floor(Math.log2(Math.abs(d))) + 1;
      bits.push(codes[n]!);
      if (n) bits.push((d > 0 ? d : d + (1 << n) - 1).toString(2).padStart(n, "0"));
      bits.push("00"); // end of block: the only AC symbol of the custom table below
    }
  }
  let s = bits.join("");
  s += "1".repeat((8 - (s.length % 8)) % 8);
  const entropy: number[] = [];
  for (let i = 0; i < s.length; i += 8) {
    const b = parseInt(s.slice(i, i + 8), 2);
    entropy.push(b);
    if (b === 0xff) entropy.push(0);
  }
  return new Uint8Array([
    0xff, 0xd8,
    ...marker(0xdb, [0, ...new Array(64).fill(8)]),
    ...marker(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]),
    ...marker(0xc4, [0x00, ...dcCounts, ...dcValues]),
    ...marker(0xc4, [0x10, 0, 1, ...new Array(14).fill(0), 0x00]),
    ...marker(0xda, [1, 1, 0x00, 0, 63, 0]),
    ...entropy,
    0xff, 0xd9,
  ]);
}

/** An asymmetric picture: four colour quadrants, a gradient across, and an F that is not symmetric under any flip. */
export function picture(w: number, h: number, kind: Kind): Rgba {
  const out = new Uint8Array(w * h * 4);
  const quant = kind === "jpeg" ? 8 : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const qx = Math.floor(x / quant) * quant, qy = Math.floor(y / quant) * quant;
      const u = qx / w, v = qy / h;
      let c: [number, number, number, number] = u < 0.5 ? (v < 0.5 ? [220, 60, 50, 255] : [60, 160, 70, 255]) : v < 0.5 ? [50, 90, 220, 255] : [230, 200, 60, 255];
      const inF = (u > 0.12 && u < 0.2 && v > 0.12 && v < 0.45) || (u >= 0.2 && u < 0.38 && v > 0.12 && v < 0.18) || (u >= 0.2 && u < 0.32 && v > 0.27 && v < 0.33);
      if (inF) c = [20, 20, 20, 255];
      if (kind === "png1") c = inF || (Math.floor(qx / 16) + Math.floor(qy / 16)) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255];
      if (kind === "jpeg") { const g = inF ? 20 : Math.round(60 + 160 * u); c = [g, g, g, 255]; }
      out.set(c, (y * w + x) * 4);
    }
  }
  return out;
}

function downsample(src: Rgba, w: number, h: number): { w: number; h: number; data: Rgba } {
  const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
  const data = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let k = 0; k < 4; k++) {
    let sum = 0, n = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const sx = x * 2 + dx, sy = y * 2 + dy;
      if (sx < w && sy < h) (sum += src[(sy * w + sx) * 4 + k]!, n++);
    }
    data[(y * nw + x) * 4 + k] = Math.round(sum / n);
  }
  return { w: nw, h: nh, data };
}

export interface RasterSpec {
  id: number;
  kind: Kind;
  width: number;
  height: number;
  edge: 256 | 512 | 1024;
  pixelToSource: Mat6;
  visibleBox?: [number, number, number, number];
  band?: 0 | 1;
  opacity?: number;
  /** Leave out the full-resolution picture (the reference render's input) when a spec does not compare against it. */
  noImage?: boolean;
}
export interface WireRaster {
  placement: RasterPlacement;
  /** `"level/col/row"` to base64 of the encoded tile. */
  tiles: Record<string, string>;
  /** The full-resolution picture, RGBA, base64: the reference render's input. */
  image: string;
}

/** `levels` follows RASTER-01: the pyramid stops at the first one-tile level. */
export const levelsFor = (w: number, h: number, edge: number): number => Math.max(1, Math.ceil(Math.log2(Math.max(w, h) / edge)) + 1);

export function buildRaster(s: RasterSpec): WireRaster {
  const levels = levelsFor(s.width, s.height, s.edge);
  const tiles: Record<string, string> = {};
  let cur = { w: s.width, h: s.height, data: picture(s.width, s.height, s.kind) };
  const full = cur.data;
  for (let level = levels - 1; level >= 0; level--) {
    for (let row = 0; row < Math.ceil(cur.h / s.edge); row++) {
      for (let col = 0; col < Math.ceil(cur.w / s.edge); col++) {
        // The producer pads an edge tile; magenta makes a padded margin that draws impossible to miss.
        const t = new Uint8Array(s.edge * s.edge * 4);
        for (let i = 0; i < s.edge * s.edge; i++) t.set([255, 0, 255, 255], i * 4);
        for (let y = 0; y < s.edge; y++) for (let x = 0; x < s.edge; x++) {
          const sx = col * s.edge + x, sy = row * s.edge + y;
          if (sx < cur.w && sy < cur.h) t.set(cur.data.subarray((sy * cur.w + sx) * 4, (sy * cur.w + sx) * 4 + 4), (y * s.edge + x) * 4);
        }
        const bytes = s.kind === "png" ? encodePng(s.edge, s.edge, t) : s.kind === "png1" ? encodePng1(s.edge, s.edge, t) : encodeJpeg(s.edge, s.edge, t);
        tiles[`${level}/${col}/${row}`] = Buffer.from(bytes).toString("base64");
      }
    }
    if (level > 0) cur = downsample(cur.data, cur.w, cur.h);
  }
  const placement: RasterPlacement = {
    id: s.id, pixelToSource: s.pixelToSource, width: s.width, height: s.height, visibleBox: s.visibleBox ?? [0, 0, s.width, s.height],
    tileEdge: s.edge, levels, codec: s.kind === "jpeg" ? 2 : 1, channels: s.kind === "png" ? 4 : s.kind === "png1" ? 1 : 1, bitDepth: s.kind === "png1" ? 1 : 8,
    opacity: s.opacity ?? 255, band: s.band ?? 0,
  };
  return { placement, tiles, image: s.noImage ? "" : Buffer.from(full).toString("base64") };
}
