import type { Map as MapLibreMap } from "maplibre-gl";
import { DEFAULTS, DEFAULT_MAX_DECODED_BYTES } from "../../config/defaults";
import { GenerationTracker, type JobTag } from "../../refine/generation";
import type { TieredCache } from "../../source/cache";
import { splitHiLo } from "../buffer_layout";
import { fitLevels, limitDecoded, takeUploads, tileTextureBytes, type FittedRaster } from "./budget";
import { DecodePool, type DecodeWorker } from "./decode";
import { apply, textureUv, tilesInView, type Mat6, type RasterPlacement, type RasterView, type TileId } from "./geometry";
import { classifyRasters, drawOrder, escapeAttribution, type SkipReason } from "./policy";
import { RasterRefusedError, type RasterProvider } from "./provider";

type Gl2 = WebGL2RenderingContext;

const VERTEX = `#version 300 es
layout(location = 0) in vec2 a_hi; layout(location = 1) in vec2 a_lo; layout(location = 2) in vec2 a_uv;
uniform vec2 u_centerHi; uniform vec2 u_centerLo; uniform mat2 u_linear; uniform vec2 u_viewport;
out vec2 v_uv;
void main() {
  vec2 p = u_linear * ((a_hi - u_centerHi) + (a_lo - u_centerLo));
  gl_Position = vec4(p / (0.5 * u_viewport), 0.0, 1.0);
  v_uv = a_uv;
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D u_tex; uniform float u_opacity;
in vec2 v_uv; out vec4 o;
void main() { o = texture(u_tex, v_uv) * u_opacity; }`;

/** The camera the stroke pass already derived, so a raster goes through the same matrix chain with the same hi/lo split. */
export interface RasterFrame {
  centerHi: [number, number];
  centerLo: [number, number];
  /** Column-major 2x2, device px per mercator unit. */
  linear: [number, number, number, number];
  viewport: [number, number];
  dpr: number;
  /** Source space to device pixels (top-left origin, y down) around a source point, from the map's own projection. */
  sourceToDevice(sx: number, sy: number, span: number): Mat6;
  /** Source space to normalised mercator, in f64. */
  sourceToWorld(x: number, y: number): [number, number];
}

export interface RasterFrameStats {
  /** The texture levels drawn this frame, ascending. */
  levels: number[];
  uploads: number;
  uploadedBytes: number;
  textures: number;
  /** Tiles asked for and not yet on screen. */
  pending: number;
  renderMs: number;
  /** Straight from the tiers: the sum of the textures, the bitmaps waiting for an upload and the encoded tiles kept. */
  textureBytes: number;
  decodedBytes: number;
  encodedBytes: number;
  /** Tiles between the request and the bitmap landing in the decoded tier. */
  decodesInFlight: number;
  /** Tiles that could not be decoded or fetched after the last attempt, and every failed attempt. */
  failedTiles: number;
  decodeFailures: number;
  /** Tiles asked of the provider so far. A context restore with the encoded bytes kept adds none. */
  requests: number;
}

export interface RasterRendererInit {
  gl: Gl2;
  cache: TieredCache;
  provider: RasterProvider;
  map: Pick<MapLibreMap, "triggerRepaint">;
  spawn: () => DecodeWorker;
  /** Ids the provider already refused with its own rule: they neither draw nor count as skipped here. */
  refused?: ReadonlySet<number> | undefined;
  /** LIMIT-16 mirrored on the host side: bitmaps held or in flight never exceed it. Defaults to the source's limit. */
  maxDecodedBytes?: number | undefined;
  onError(where: string, e: unknown): void;
  /** A raster the module refused by a rule: reported once, then dropped. */
  onRefused?: ((e: { rasterId: number; rule: string; message: string }) => void) | undefined;
  onDecode?: ((e: { id: number; codec: number; ms: number }) => void) | undefined;
  onFrame?: ((s: RasterFrameStats) => void) | undefined;
  now?: (() => number) | undefined;
}

const MAX_IN_FLIGHT = 6;
/** A tile that fails is tried this many times in all, with a wait that doubles from 30 frames, and then counts as missing. */
const MAX_ATTEMPTS = 3;
const RETRY_FRAMES = 30;
const MAX_READY = 8;

const key = (id: number, level: number, col: number, row: number) => `r${id}/${level}/${col}/${row}`;

interface Used {
  p: RasterPlacement;
  level: number;
  col: number;
  row: number;
  rect: [number, number, number, number];
  tex: WebGLTexture;
}

/**
 * Draws PVec rasters as textured quads through the stroke pass's matrix chain. Decode is in a worker, textures are
 * entries of the `gpu` tier of the source's `TieredCache` (so the layer's byte accounting and eviction cover them), and
 * uploads share the 4 MiB and 2 ms a frame budget of the buffer pool. Everything GL runs inside the caller's
 * `GlStateGuard.run`: it binds texture unit 0 and the raster program and nothing else, and never reads GL state back.
 */
export class RasterRenderer {
  readonly placements: readonly RasterPlacement[];
  readonly skipped: { id: number; reason: SkipReason }[];
  private readonly under: RasterPlacement[];
  private readonly over: RasterPlacement[];
  private readonly pool: DecodePool;
  private readonly textures = new Map<string, WebGLTexture>();
  /** Tiles between the request and their bitmap landing in the decoded tier, with the decoded bytes each will take. */
  private readonly inFlight = new Map<string, { tag: JobTag; bytes: number }>();
  /** Bitmaps waiting for their upload: the payloads of the decoded tier's entries. */
  private readonly bitmaps = new Map<string, ImageBitmap>();
  /** The generation check of the curve refiner, one entity per tile key: a superseded decode is refused on arrival. */
  private readonly gens = new GenerationTracker();
  private readonly tileNo = new Map<string, number>();
  /** The keys of the current plan: the fitted level's tiles and the coarser level kept under them. */
  private wantedKeys = new Set<string>();
  private requests = 0;
  private frameNo = 0;
  private failedTiles = 0;
  private decodeFailures = 0;
  private readonly attempts = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  /** Rasters the module refused: they are neither requested nor drawn. */
  private readonly dead = new Set<number>();
  private epoch = 0;
  private readonly maxDecoded: number;
  private readonly failed = new Set<string>();
  private readonly ready: { key: string; id: number; bytes: number }[] = [];
  private readonly quads = new Map<string, Float32Array>();
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: (WebGLBuffer | null)[] = [null, null];
  private sent: (string | undefined)[] = [undefined, undefined];
  private u: Record<string, WebGLUniformLocation | null> = {};
  private used: Used[] = [];
  private fitted = new Map<number, FittedRaster>();
  private lastMats: number[] = [];
  private version = 0;
  private stats: RasterFrameStats = { levels: [], uploads: 0, uploadedBytes: 0, textures: 0, pending: 0, renderMs: 0, textureBytes: 0, decodedBytes: 0, encodedBytes: 0, decodesInFlight: 0, failedTiles: 0, decodeFailures: 0, requests: 0 };
  private disposed = false;

  constructor(private readonly o: RasterRendererInit) {
    const c = classifyRasters(o.provider.placements(), o.refused);
    this.placements = c.drawable;
    this.skipped = c.unrastered;
    ({ under: this.under, over: this.over } = drawOrder(c.drawable));
    this.pool = new DecodePool(o.spawn);
    this.maxDecoded = o.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
  }

  /** The attribution strings of the rasters drawn, escaped for MapLibre's attribution control. */
  attributions(): string[] {
    return this.placements.flatMap((p) => (p.attribution ? [escapeAttribution(p.attribution)] : []));
  }

  get drawsAnything(): boolean {
    return this.live().length > 0;
  }

  /** The rasters that draw: the ones this reader can show and the module has not refused. */
  live(): readonly RasterPlacement[] {
    return this.placements.filter((p) => !this.dead.has(p.id));
  }

  /** Decide the levels, ask for what is missing and do this frame's uploads. Call once per frame, before `draw`. */
  prepare(f: RasterFrame): void {
    if (this.disposed) return;
    const t0 = (this.o.now ?? performance.now.bind(performance))();
    this.frameNo++;
    const all = [...this.under, ...this.over].filter((p) => !this.dead.has(p.id));
    const views = new Map<number, RasterView>();
    const mats: number[] = [this.version, this.o.cache.ceiling("gpu"), f.viewport[0], f.viewport[1]];
    for (const p of all) {
      const span = Math.max(p.visibleBox[2] - p.visibleBox[0], p.visibleBox[3] - p.visibleBox[1]) / 8;
      const [cx, cy] = apply(p.pixelToSource, (p.visibleBox[0] + p.visibleBox[2]) / 2, (p.visibleBox[1] + p.visibleBox[3]) / 2);
      const norm = Math.hypot(p.pixelToSource[0], p.pixelToSource[2]) || 1;
      const m = f.sourceToDevice(cx, cy, span * norm);
      views.set(p.id, { sourceToDevice: m, width: f.viewport[0], height: f.viewport[1] });
      mats.push(...m);
    }
    // A steady frame (same camera, nothing in flight, nothing to upload) reuses last frame's choice outright.
    const same = mats.length === this.lastMats.length && mats.every((x, i) => x === this.lastMats[i]);
    const retryDue = [...this.retryAt.values()].some((t) => t <= this.frameNo);
    if (same && !this.ready.length && !this.inFlight.size && !retryDue) {
      this.stats.uploads = 0;
      this.stats.uploadedBytes = 0;
      this.account();
      return;
    }
    if (!same) {
      this.lastMats = mats;
      this.fitted.clear();
      for (const p of all) {
        // Rasters share the gpu tier, so the fit is made per raster against its share of the ceiling.
        const share = this.o.cache.ceiling("gpu") / Math.max(1, all.length);
        this.fitted.set(p.id, fitLevels([p], views.get(p.id)!, share)[0]!);
      }
      // LIMIT-16 on the host side bounds the plan too: a level whose tiles could not all be held decoded is not asked for.
      limitDecoded(this.fitted, all, views, this.maxDecoded);
      this.plan(all);
    }
    this.request(all);
    this.upload();
    this.collect(f, views);
    this.account();
    this.stats.renderMs = (this.o.now ?? performance.now.bind(performance))() - t0;
  }

  /** The keys this plan needs, the level the cache should rank tiles against, and the decodes the plan no longer wants. */
  private plan(all: RasterPlacement[]): void {
    const wanted = new Set<string>();
    const levels = new Map<number, number>();
    for (const p of all) {
      const fit = this.fitted.get(p.id);
      if (!fit) continue;
      levels.set(p.id, fit.level);
      for (const t of fit.tiles) {
        wanted.add(key(p.id, fit.level, t.col, t.row));
        if (fit.level > 0) wanted.add(key(p.id, fit.level - 1, t.col >> 1, t.row >> 1));
      }
    }
    this.wantedKeys = wanted;
    this.o.cache.setWantedLevels(levels);
    // A decode in flight for a tile the plan dropped is superseded: its bitmap is closed when it lands.
    for (const kk of this.inFlight.keys()) if (!wanted.has(kk)) this.gens.next(this.noOf(kk));
  }

  private noOf(kk: string): number {
    let n = this.tileNo.get(kk);
    if (n === undefined) this.tileNo.set(kk, (n = this.tileNo.size + 1));
    return n;
  }

  private request(all: RasterPlacement[]): void {
    for (const p of all) {
      const fit = this.fitted.get(p.id);
      if (!fit) continue;
      const wanted: [number, TileId][] = [];
      // The retained coarser level first, so something is on screen before the fine tiles arrive.
      if (fit.level > 0) {
        const seen = new Set<string>();
        for (const t of fit.tiles) {
          // Once the tile itself is resident the coarser one has nothing left to cover.
          if (this.textures.has(key(p.id, fit.level, t.col, t.row))) continue;
          const c = { col: t.col >> 1, row: t.row >> 1 };
          if (!seen.has(`${c.col}/${c.row}`)) (seen.add(`${c.col}/${c.row}`), wanted.push([fit.level - 1, c]));
        }
      }
      for (const t of fit.tiles) wanted.push([fit.level, t]);
      this.o.provider.hint?.(p.id, fit.level, fit.tiles);
      for (const [level, t] of wanted) {
        const kk = key(p.id, level, t.col, t.row);
        if (this.textures.has(kk) || this.inFlight.has(kk) || this.failed.has(kk) || this.bitmaps.has(kk)) continue;
        if ((this.retryAt.get(kk) ?? 0) > this.frameNo) continue;
        if (this.inFlight.size >= MAX_IN_FLIGHT || this.ready.length >= MAX_READY) return;
        // LIMIT-16 on the host side: the bitmaps held plus the ones in flight, plus this one, stay under the cap.
        const bytes = tileTextureBytes(p.tileEdge);
        let flying = 0;
        for (const f of this.inFlight.values()) flying += f.bytes;
        if (this.o.cache.bytes("decoded") + flying + bytes > Math.min(this.maxDecoded, this.o.cache.ceiling("decoded"))) return;
        this.fetch(p, level, t, kk, bytes);
      }
    }
  }

  private fetch(p: RasterPlacement, level: number, t: TileId, kk: string, bytes: number): void {
    const tag = this.gens.next(this.noOf(kk));
    this.inFlight.set(kk, { tag, bytes });
    const meta = { raster: p.id, level, visible: this.wantedKeys.has(kk) };
    void (async () => {
      try {
        // The encoded bytes are kept in the compressed tier: a context restore decodes them again without a request.
        let encoded = this.o.cache.get("compressed", kk) as Uint8Array | undefined;
        if (!encoded) {
          const got = await this.o.provider.tile(p.id, level, t.col, t.row);
          this.requests++;
          if (this.disposed) return;
          if (!got) return void this.failed.add(kk);
          encoded = got;
          this.o.cache.put("compressed", kk, got, meta);
        }
        if (this.gens.check(tag) !== "accept") return;
        // The worker gets a copy, so the retained bytes are never detached by the transfer.
        const d = await this.pool.decode(encoded.slice(), p.codec);
        if (this.disposed || this.gens.check(tag) !== "accept") return void d.bitmap.close();
        this.o.onDecode?.({ id: p.id, codec: p.codec, ms: d.ms });
        const held = d.bitmap.width * d.bitmap.height * 4;
        if (!this.o.cache.put("decoded", kk, held, { ...meta, payload: d.bitmap })) return void (d.bitmap.close(), this.failed.add(kk));
        this.bitmaps.set(kk, d.bitmap);
        this.attempts.delete(kk);
        this.retryAt.delete(kk);
        this.ready.push({ key: kk, id: p.id, bytes: held });
        this.reconcileBitmaps();
      } catch (e) {
        if (e instanceof RasterRefusedError) this.refuse(p, e);
        else this.missing(kk, e);
      } finally {
        this.inFlight.delete(kk);
        if (!this.disposed) this.o.map.triggerRepaint?.();
      }
    })();
  }

  /** A tile that could not be had: tried again a bounded number of times, then counted as missing. Never a loop, never an exception. */
  private missing(kk: string, e: unknown): void {
    if (this.disposed) return;
    const n = (this.attempts.get(kk) ?? 0) + 1;
    this.attempts.set(kk, n);
    this.decodeFailures++;
    if (n >= MAX_ATTEMPTS) {
      this.failed.add(kk);
      this.retryAt.delete(kk);
      this.failedTiles++;
      this.o.onError(`raster tile ${kk}`, e);
    } else {
      this.retryAt.set(kk, this.frameNo + RETRY_FRAMES * 2 ** (n - 1));
    }
  }

  /** The module refused this raster by a rule. One report, and nothing of it is drawn or asked for again. */
  private refuse(p: RasterPlacement, e: RasterRefusedError): void {
    if (this.dead.has(p.id) || this.disposed) return;
    this.dead.add(p.id);
    this.o.onRefused?.({ rasterId: p.id, rule: e.rule, message: e.message });
    const gl = this.o.gl;
    for (const [kk, tex] of this.textures) {
      if (!kk.startsWith(`r${p.id}/`)) continue;
      gl.deleteTexture(tex);
      this.textures.delete(kk);
      this.o.cache.drop("gpu", kk);
    }
    for (const r of [...this.ready]) {
      if (r.id !== p.id) continue;
      this.ready.splice(this.ready.indexOf(r), 1);
      this.bitmaps.get(r.key)?.close();
      this.bitmaps.delete(r.key);
      this.o.cache.drop("decoded", r.key);
    }
    for (const kk of this.inFlight.keys()) if (kk.startsWith(`r${p.id}/`)) this.gens.next(this.noOf(kk));
    this.used = this.used.filter((u) => u.p.id !== p.id);
    this.fitted.delete(p.id);
    this.lastMats = [];
    this.o.map.triggerRepaint?.();
  }

  /** A bitmap whose decoded-tier entry was evicted is closed here, so the tier's bytes are the bitmaps alive. */
  private reconcileBitmaps(): void {
    for (const [kk, b] of this.bitmaps) {
      if (this.o.cache.has("decoded", kk)) continue;
      b.close();
      this.bitmaps.delete(kk);
      const i = this.ready.findIndex((r) => r.key === kk);
      if (i >= 0) this.ready.splice(i, 1);
    }
  }

  private upload(): void {
    const gl = this.o.gl;
    const now = this.o.now ?? performance.now.bind(performance);
    // Bitmaps of tiles the plan dropped while they waited never reach the gpu tier.
    for (let i = this.ready.length - 1; i >= 0; i--) {
      const r = this.ready[i]!;
      if (this.wantedKeys.has(r.key)) continue;
      this.ready.splice(i, 1);
      this.bitmaps.get(r.key)?.close();
      this.bitmaps.delete(r.key);
      this.o.cache.drop("decoded", r.key);
    }
    const taken = takeUploads(this.ready, { budgetBytes: DEFAULTS.uploadBudgetBytes, budgetMs: DEFAULTS.uploadBudgetMs, now });
    let bytes = 0;
    for (const u of taken) {
      const bitmap = this.bitmaps.get(u.key);
      this.bitmaps.delete(u.key);
      if (!bitmap) continue;
      const tex = gl.createTexture();
      if (!tex) { bitmap.close(); this.o.cache.drop("decoded", u.key); continue; }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      // The bitmap is closed and leaves the decoded tier before the texture enters the gpu tier: a tile is never both.
      bitmap.close();
      this.o.cache.drop("decoded", u.key);
      const level = Number(u.key.split("/")[1]);
      const stored = this.o.cache.put("gpu", u.key, u.bytes, { visible: true, payload: tex, raster: u.id, level });
      if (!stored) { gl.deleteTexture(tex); this.failed.add(u.key); continue; }
      this.textures.set(u.key, tex);
      bytes += u.bytes;
    }
    // Evictions happen inside `put`; a texture whose entry is gone is deleted here, so the cache's bytes are the GL bytes.
    for (const [kk, tex] of this.textures) if (!this.o.cache.has("gpu", kk)) (gl.deleteTexture(tex), this.textures.delete(kk));
    this.reconcileBitmaps();
    if (taken.length) this.version++;
    this.stats.uploads = taken.length;
    this.stats.uploadedBytes = bytes;
  }

  /** For each tile the view needs, the finest texture that exists: the tile itself, else the nearest coarser ancestor. */
  private collect(f: RasterFrame, views: Map<number, RasterView>): void {
    void f;
    void views;
    this.used = [];
    const levels = new Set<number>();
    const visible = new Set<string>();
    let pending = 0;
    for (const p of [...this.under, ...this.over]) {
      const fit = this.fitted.get(p.id);
      if (!fit || this.dead.has(p.id)) continue;
      const span = p.tileEdge * 2 ** (p.levels - 1 - fit.level);
      for (const t of fit.tiles) {
        const rect: [number, number, number, number] = [t.col * span, t.row * span, (t.col + 1) * span, (t.row + 1) * span];
        let found = false;
        for (let level = fit.level, c = t.col, r = t.row; level >= 0; level--, c >>= 1, r >>= 1) {
          const kk = key(p.id, level, c, r);
          const tex = this.textures.get(kk);
          if (!tex) continue;
          visible.add(kk);
          levels.add(level);
          this.used.push({ p, level, col: c, row: r, rect, tex });
          found = level === fit.level;
          break;
        }
        if (!found) pending++;
      }
    }
    // The retained coarser level goes once the finer tiles that replace it are resident: only textures drawn this frame
    // (or in the plan) stay above the eviction line.
    for (const [kk, tex] of this.textures) {
      const id = Number(kk.slice(1, kk.indexOf("/")));
      const fit = this.fitted.get(id);
      const level = Number(kk.split("/")[1]);
      if (!fit || level >= fit.level || visible.has(kk)) continue;
      if (!this.wantedKeys.has(kk)) continue;
      this.o.gl.deleteTexture(tex);
      this.textures.delete(kk);
      this.o.cache.drop("gpu", kk);
      this.wantedKeys.delete(kk);
    }
    this.o.cache.setVisible(new Set([...visible, ...this.wantedKeys]));
    this.stats.levels = [...levels].sort((a, b) => a - b);
    this.stats.textures = this.textures.size;
    this.stats.pending = pending;
  }

  /**
   * A new georeference. Only the corner positions depend on it: the quads are rebuilt and re-sent through the frame budget, the
   * levels are chosen again from the new scale, and textures, bitmaps and decodes in flight stay as they are.
   */
  setTransformEpoch(epoch: number): void {
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    this.quads.clear();
    this.sent = [undefined, undefined];
    this.lastMats = [];
  }

  /** What the tiers hold now, read from the accounting. */
  private account(): void {
    const c = this.o.cache;
    this.stats.textureBytes = c.bytes("gpu");
    this.stats.decodedBytes = c.bytes("decoded");
    this.stats.encodedBytes = c.bytes("compressed");
    this.stats.decodesInFlight = this.inFlight.size;
    this.stats.requests = this.requests;
    this.stats.failedTiles = this.failedTiles;
    this.stats.decodeFailures = this.decodeFailures;
  }

  /** Draw the rasters of one band. Inside the caller's guard, after `prepare`. */
  draw(band: 0 | 1, f: RasterFrame): void {
    if (this.disposed) return;
    const gl = this.o.gl;
    const quads = this.used.filter((u) => u.p.band === band).sort((a, b) => a.p.id - b.p.id);
    if (!quads.length) return;
    if (!this.program) this.build();
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo[band]!);
    this.pointers();
    // The vertices are world positions, independent of the camera, so they are re-sent only when the set of quads changes.
    const sig = quads.map((q) => `${q.p.id}|${q.level}|${q.col}|${q.row}|${q.rect.join(",")}`).join(";");
    if (sig !== this.sent[band]) {
      const data = new Float32Array(quads.length * 24);
      quads.forEach((q, i) => data.set(this.quad(q, f), i * 24));
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.sent[band] = sig;
    }
    gl.uniform2fv(this.u.u_centerHi!, f.centerHi);
    gl.uniform2fv(this.u.u_centerLo!, f.centerLo);
    gl.uniformMatrix2fv(this.u.u_linear!, false, f.linear);
    gl.uniform2fv(this.u.u_viewport!, f.viewport);
    gl.uniform1i(this.u.u_tex!, 0);
    gl.activeTexture(gl.TEXTURE0);
    quads.forEach((q, i) => {
      gl.uniform1f(this.u.u_opacity!, q.p.opacity / 255);
      gl.bindTexture(gl.TEXTURE_2D, q.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, i * 4, 4);
    });
  }

  /** Four corners (top-left, top-right, bottom-left, bottom-right) as hi, lo and texture coordinates, 6 floats each. */
  private quad(q: Used, f: RasterFrame): Float32Array {
    const ck = `${q.p.id}|${q.level}|${q.col}|${q.row}|${q.rect.join(",")}`;
    const hit = this.quads.get(ck);
    if (hit) return hit;
    const a = textureUv(q.p, q.level, q.col, q.row, q.rect)!;
    const out = new Float32Array(24);
    const corners: [number, number, number, number][] = [
      [a.px[0], a.px[1], a.uv[0], a.uv[1]], [a.px[2], a.px[1], a.uv[2], a.uv[1]],
      [a.px[0], a.px[3], a.uv[0], a.uv[3]], [a.px[2], a.px[3], a.uv[2], a.uv[3]],
    ];
    corners.forEach(([px, py, u, v], i) => {
      const [sx, sy] = apply(q.p.pixelToSource, px, py);
      const [wx, wy] = f.sourceToWorld(sx, sy);
      const hx = splitHiLo(wx), hy = splitHiLo(wy);
      out.set([hx.hi, hy.hi, hx.lo, hy.lo, u, v], i * 6);
    });
    if (this.quads.size > 4096) this.quads.clear();
    this.quads.set(ck, out);
    return out;
  }

  private build(): void {
    const gl = this.o.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`raster shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, VERTEX), fs = mk(gl.FRAGMENT_SHADER, FRAGMENT);
    const p = (this.program = gl.createProgram()!);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`raster link: ${gl.getProgramInfoLog(p)}`);
    for (const n of ["u_centerHi", "u_centerLo", "u_linear", "u_viewport", "u_tex", "u_opacity"]) this.u[n] = gl.getUniformLocation(p, n);
    this.vao = gl.createVertexArray();
    this.vbo = [gl.createBuffer(), gl.createBuffer()];
    this.sent = [undefined, undefined];
  }

  /** Attribute layout of the buffer bound to ARRAY_BUFFER, recorded in the VAO (cheap, and the buffer differs per band). */
  private pointers(): void {
    const gl = this.o.gl;
    for (const [loc, off] of [[0, 0], [1, 8], [2, 16]] as const) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 24, off);
    }
  }

  /** Called once after `draw` of both bands; reports the frame to the debug hook. */
  endFrame(): void {
    this.o.onFrame?.({ ...this.stats });
    if (this.ready.length || this.inFlight.size || this.retryAt.size) this.o.map.triggerRepaint?.();
  }

  /** The GL objects are gone. Tiles whose encoded bytes are still in the compressed tier decode again without a request. */
  onContextLost(): void {
    this.program = this.vao = null;
    this.vbo = [null, null];
    // The textures went with the context. The encoded bytes stay in the compressed tier, so the rebuild decodes them again.
    for (const kk of this.textures.keys()) this.o.cache.drop("gpu", kk);
    this.textures.clear();
    this.quads.clear();
    this.used = [];
    this.lastMats = [];
    this.version++;
    this.failed.clear();
  }

  dispose(): void {
    this.disposed = true;
    const gl = this.o.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t);
    this.textures.clear();
    for (const b of this.bitmaps.values()) b.close();
    this.bitmaps.clear();
    this.ready.length = 0;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    for (const b of this.vbo) if (b) gl.deleteBuffer(b);
    this.vbo = [null, null];
    this.program = this.vao = null;
    this.pool.dispose();
    this.o.provider.release?.();
  }
}

export { tileTextureBytes, tilesInView };
