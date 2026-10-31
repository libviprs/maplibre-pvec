import type { Map as MapLibreMap } from "maplibre-gl";
import { DEFAULTS } from "../../config/defaults";
import type { TieredCache } from "../../source/cache";
import { splitHiLo } from "../buffer_layout";
import { fitLevels, takeUploads, tileTextureBytes, type FittedRaster } from "./budget";
import { DecodePool, type DecodeWorker } from "./decode";
import { apply, textureUv, tilesInView, type Mat6, type RasterPlacement, type RasterView, type TileId } from "./geometry";
import { classifyRasters, drawOrder, escapeAttribution, type SkipReason } from "./policy";
import type { RasterProvider } from "./provider";

type Gl2 = WebGL2RenderingContext;

const VERTEX = `#version 300 es
in vec2 a_hi; in vec2 a_lo; in vec2 a_uv;
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
}

export interface RasterRendererInit {
  gl: Gl2;
  cache: TieredCache;
  provider: RasterProvider;
  map: Pick<MapLibreMap, "triggerRepaint">;
  spawn: () => DecodeWorker;
  onSkipped(text: string): void;
  onError(where: string, e: unknown): void;
  onDecode?: ((e: { id: number; codec: number; ms: number }) => void) | undefined;
  onFrame?: ((s: RasterFrameStats) => void) | undefined;
  now?: (() => number) | undefined;
}

const MAX_IN_FLIGHT = 6;
const MAX_READY = 8;
const REASON_TEXT: Record<SkipReason, string> = { "unknown-codec": "unknown codec", "jpeg-with-alpha": "jpeg with alpha" };

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
  private readonly inFlight = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly ready: { key: string; id: number; bytes: number; bitmap: ImageBitmap }[] = [];
  private readonly quads = new Map<string, Float32Array>();
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private used: Used[] = [];
  private fitted = new Map<number, FittedRaster>();
  private fitKey = "";
  private version = 0;
  private stats: RasterFrameStats = { levels: [], uploads: 0, uploadedBytes: 0, textures: 0, pending: 0, renderMs: 0 };
  private disposed = false;

  constructor(private readonly o: RasterRendererInit) {
    const c = classifyRasters(o.provider.placements());
    this.placements = c.drawable;
    this.skipped = c.unrastered;
    ({ under: this.under, over: this.over } = drawOrder(c.drawable));
    this.pool = new DecodePool(o.spawn);
    if (c.unrastered.length) {
      const reasons = [...new Set(c.unrastered.map((s) => REASON_TEXT[s.reason]))].join(", ");
      o.onSkipped(`skipped ${c.unrastered.length} ${c.unrastered.length === 1 ? "raster" : "rasters"}: ${reasons}`);
    }
  }

  /** The attribution strings of the rasters drawn, escaped for MapLibre's attribution control. */
  attributions(): string[] {
    return this.placements.flatMap((p) => (p.attribution ? [escapeAttribution(p.attribution)] : []));
  }

  get drawsAnything(): boolean {
    return this.placements.length > 0;
  }

  /** Decide the levels, ask for what is missing and do this frame's uploads. Call once per frame, before `draw`. */
  prepare(f: RasterFrame): void {
    if (this.disposed) return;
    const t0 = (this.o.now ?? performance.now.bind(performance))();
    const all = [...this.under, ...this.over];
    const views = new Map<number, RasterView>();
    let k = `${this.version}|${this.o.cache.ceiling("gpu")}|${f.viewport[0]}x${f.viewport[1]}`;
    for (const p of all) {
      const span = Math.max(p.visibleBox[2] - p.visibleBox[0], p.visibleBox[3] - p.visibleBox[1]) / 8;
      const [cx, cy] = apply(p.pixelToSource, (p.visibleBox[0] + p.visibleBox[2]) / 2, (p.visibleBox[1] + p.visibleBox[3]) / 2);
      const norm = Math.hypot(p.pixelToSource[0], p.pixelToSource[2]) || 1;
      const m = f.sourceToDevice(cx, cy, span * norm);
      views.set(p.id, { sourceToDevice: m, width: f.viewport[0], height: f.viewport[1] });
      k += `|${m.map((x) => x.toPrecision(9)).join(",")}`;
    }
    if (k !== this.fitKey) {
      this.fitKey = k;
      this.fitted.clear();
      for (const p of all) {
        // Rasters share the gpu tier, so the fit is made per raster against its share of the ceiling.
        const share = this.o.cache.ceiling("gpu") / Math.max(1, all.length);
        this.fitted.set(p.id, fitLevels([p], views.get(p.id)!, share)[0]!);
      }
    }
    this.request(all);
    this.upload();
    this.collect(f, views);
    this.stats.renderMs = (this.o.now ?? performance.now.bind(performance))() - t0;
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
          const c = { col: t.col >> 1, row: t.row >> 1 };
          if (!seen.has(`${c.col}/${c.row}`)) (seen.add(`${c.col}/${c.row}`), wanted.push([fit.level - 1, c]));
        }
      }
      for (const t of fit.tiles) wanted.push([fit.level, t]);
      this.o.provider.hint?.(p.id, fit.level, fit.tiles);
      for (const [level, t] of wanted) {
        const kk = key(p.id, level, t.col, t.row);
        if (this.textures.has(kk) || this.inFlight.has(kk) || this.failed.has(kk)) continue;
        if (this.inFlight.size >= MAX_IN_FLIGHT || this.ready.length >= MAX_READY) return;
        this.fetch(p, level, t, kk);
      }
    }
  }

  private fetch(p: RasterPlacement, level: number, t: TileId, kk: string): void {
    this.inFlight.add(kk);
    void (async () => {
      try {
        const bytes = await this.o.provider.tile(p.id, level, t.col, t.row);
        if (this.disposed) return;
        if (!bytes) return void this.failed.add(kk);
        const d = await this.pool.decode(bytes, p.codec);
        if (this.disposed) return void d.bitmap.close();
        this.o.onDecode?.({ id: p.id, codec: p.codec, ms: d.ms });
        this.ready.push({ key: kk, id: p.id, bytes: d.bitmap.width * d.bitmap.height * 4, bitmap: d.bitmap });
      } catch (e) {
        this.failed.add(kk);
        if (!this.disposed) this.o.onError(`raster tile ${kk}`, e);
      } finally {
        this.inFlight.delete(kk);
        if (!this.disposed) this.o.map.triggerRepaint?.();
      }
    })();
  }

  private upload(): void {
    const gl = this.o.gl;
    const now = this.o.now ?? performance.now.bind(performance);
    const taken = takeUploads(this.ready, { budgetBytes: DEFAULTS.uploadBudgetBytes, budgetMs: DEFAULTS.uploadBudgetMs, now });
    let bytes = 0;
    for (const u of taken) {
      const tex = gl.createTexture();
      if (!tex) { u.bitmap.close(); continue; }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, u.bitmap);
      u.bitmap.close();
      const stored = this.o.cache.put("gpu", u.key, u.bytes, { visible: true, payload: tex });
      if (!stored) { gl.deleteTexture(tex); this.failed.add(u.key); continue; }
      this.textures.set(u.key, tex);
      bytes += u.bytes;
    }
    // Evictions happen inside `put`; a texture whose entry is gone is deleted here, so the cache's bytes are the GL bytes.
    for (const [kk, tex] of this.textures) if (!this.o.cache.has("gpu", kk)) (gl.deleteTexture(tex), this.textures.delete(kk));
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
      if (!fit) continue;
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
    this.o.cache.setVisible(visible);
    this.stats.levels = [...levels].sort((a, b) => a - b);
    this.stats.textures = this.textures.size;
    this.stats.pending = pending;
  }

  /** Draw the rasters of one band. Inside the caller's guard, after `prepare`. */
  draw(band: 0 | 1, f: RasterFrame): void {
    if (this.disposed) return;
    const gl = this.o.gl;
    const quads = this.used.filter((u) => u.p.band === band).sort((a, b) => a.p.id - b.p.id);
    if (!quads.length) return;
    if (!this.program) this.build();
    const data = new Float32Array(quads.length * 24);
    quads.forEach((q, i) => data.set(this.quad(q, f), i * 24));
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
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
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    for (const [name, size, off] of [["a_hi", 2, 0], ["a_lo", 2, 8], ["a_uv", 2, 16]] as const) {
      const loc = gl.getAttribLocation(p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 24, off);
    }
  }

  /** Called once after `draw` of both bands; reports the frame to the debug hook. */
  endFrame(): void {
    this.o.onFrame?.({ ...this.stats });
    if (this.ready.length || this.inFlight.size) this.o.map.triggerRepaint?.();
  }

  /** The GL objects are gone. The decoded bitmaps were closed on upload, so tiles are fetched and decoded again. */
  onContextLost(): void {
    this.program = this.vao = this.vbo = null;
    this.textures.clear();
    this.quads.clear();
    this.used = [];
    this.fitKey = "";
    this.version++;
    this.failed.clear();
  }

  dispose(): void {
    this.disposed = true;
    const gl = this.o.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t);
    this.textures.clear();
    for (const r of this.ready) r.bitmap.close();
    this.ready.length = 0;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    this.program = this.vao = this.vbo = null;
    this.pool.dispose();
    this.o.provider.release?.();
  }
}

export { tileTextureBytes, tilesInView };
