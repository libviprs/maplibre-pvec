import type { Map as MapLibreMap } from "maplibre-gl";
import type { StrokeStyle } from "../components/hooks";
import type { RasterInfo, RasterSkippedEvent } from "../diagnostics/events";
import type { EntityDraw } from "../decode/tier0";
import { BufferPool } from "../render/buffer_pool";
import { packPolyline, splitHiLo } from "../render/buffer_layout";
import { GlStateGuard } from "../render/gl_state";
import { StrokeRenderer } from "../render/stroke/renderer";
import type { DecodeWorker } from "../render/raster/decode";
import { spawnDecodeWorker } from "../workers/raster_decode";
import { escapeAttribution, SKIP_TEXT } from "../render/raster/policy";
import type { RasterProvider } from "../render/raster/provider";
import { RasterRenderer, type RasterFrame, type RasterFrameStats } from "../render/raster/renderer";
import type { TieredCache } from "../source/cache";
import { createGeoTransform, type GeoReference } from "../transform/georeference";
import { lngLatToMercator, mercatorToLngLat } from "../transform/projection";
import { sourceToWorld } from "../transform/rebase";
import type { GlResources } from "./glresources";

type Gl2 = WebGL2RenderingContext;

export interface EngineInit {
  gl: Gl2;
  map: MapLibreMap;
  res: GlResources;
  reference: GeoReference | undefined;
  style(entityId: string): StrokeStyle;
  visible(entityId: string): boolean;
  /** Present only when a test wants the guard's debug diff for every frame. */
  onStateDiff: ((names: string[]) => void) | undefined;
  onError(where: string, e: unknown): void;
  /** The source's tiered cache: raster textures are entries of its gpu tier. */
  cache: TieredCache;
  /** The raster stream of the file, or undefined when the module has no raster exports or the file no raster. */
  rasters?: RasterProvider | undefined;
  /** Tells the host which rasters this reader did not draw, once per raster. */
  /** `limits.maxDecodedBytes`: the bitmaps of the raster path in flight stay under it. */
  maxDecodedBytes?: number | undefined;
  onRasterSkipped?: ((e: RasterSkippedEvent) => void) | undefined;
  /** Debug hooks of the raster path: per frame stats and per tile decode time. */
  onRasterFrame?: ((s: RasterFrameStats) => void) | undefined;
  onRasterDecode?: ((e: { id: number; codec: number; ms: number }) => void) | undefined;
  spawnDecode?: (() => DecodeWorker) | undefined;
}

interface Group {
  key: string;
  color: [number, number, number, number];
  widthCss: number;
  dash: [number, number] | undefined;
}

const KINDS = { createBuffer: "buffer", createVertexArray: "vao", createProgram: "program", createTexture: "texture" } as const;
const DELETES = { deleteBuffer: "buffer", deleteVertexArray: "vao", deleteProgram: "program", deleteTexture: "texture" } as const;

/** The GL context with every object the add-on creates tracked in `res`, so teardown is one loop. */
function tracked(gl: Gl2, res: GlResources): Gl2 {
  return new Proxy(gl, {
    get(target, prop) {
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof v !== "function") return v;
      const f = v as (...a: unknown[]) => unknown;
      if (prop in KINDS) {
        const kind = KINDS[prop as keyof typeof KINDS];
        return () => {
          const h = f.call(target) as object | null;
          if (h) res.track(kind, h);
          return h;
        };
      }
      if (prop in DELETES) {
        const kind = DELETES[prop as keyof typeof DELETES];
        return (h: object | null) => {
          if (h) res.untrack(kind, h);
          return f.call(target, h);
        };
      }
      return f.bind(target);
    },
  });
}

const NAMED: Record<string, [number, number, number]> = { black: [0, 0, 0], white: [1, 1, 1], red: [1, 0, 0] };
/** #rgb, #rrggbb, #rrggbbaa, rgb() and rgba(). Anything else is black, which is also the default style. */
export function parseColor(s: string): [number, number, number, number] {
  const t = s.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(t)?.[1];
  if (hex && [3, 6, 8].includes(hex.length)) {
    const h = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(t)?.[1]?.split(",").map((x) => parseFloat(x));
  if (fn && fn.length >= 3 && fn.every(Number.isFinite)) return [fn[0]! / 255, fn[1]! / 255, fn[2]! / 255, fn[3] ?? 1];
  const named = NAMED[t];
  return named ? [...named, 1] : [0, 0, 0, 1];
}

/** Decoder output to the pool and onto the screen: the real buffer pool, stroke renderer and state guard. */
export class StrokeEngine {
  private readonly gl: Gl2;
  private readonly tgl: Gl2;
  private readonly guard: GlStateGuard;
  private pool: BufferPool | undefined;
  private renderer: StrokeRenderer | undefined;
  private groups: Group[] = [];
  private frame = 0;
  private lost = false;
  private raster: RasterRenderer | undefined;
  private rasterOn = true;
  private lastRasterStats: RasterFrameStats | undefined;
  private reference: GeoReference | undefined;
  /** Bumped by every new georeference: it guards the rebuild of positions the way it guards stroke tessellations. */
  private transformEpoch = 0;
  private lastDraws: readonly EntityDraw[] | undefined;
  skipped = 0;

  constructor(private readonly o: EngineInit) {
    this.gl = o.gl;
    this.tgl = tracked(o.gl, o.res);
    this.guard = new GlStateGuard(o.gl, { debug: o.onStateDiff !== undefined });
    this.reference = o.reference;
    this.makeRaster();
  }

  private makeRaster(): void {
    const o = this.o;
    if (this.raster || !o.rasters || !this.reference) return;
    this.raster = new RasterRenderer({
      gl: this.tgl,
      cache: o.cache,
      provider: o.rasters,
      map: o.map,
      spawn: o.spawnDecode ?? spawnDecodeWorker,
      maxDecodedBytes: o.maxDecodedBytes,
      refused: new Set((o.rasters.skipped?.() ?? []).map((s) => s.id)),
      onError: o.onError,
      onRefused: (e) => o.onRasterSkipped?.(e),
      onDecode: o.onRasterDecode,
      onFrame: (st) => {
        this.lastRasterStats = st;
        o.onRasterFrame?.(st);
      },
    });
    // What pvec-wasm refused comes with its own rule; what this reader cannot draw (a codec it does not know) is RASTER-04.
    for (const s of o.rasters.skipped?.() ?? []) o.onRasterSkipped?.({ rasterId: s.id, rule: s.rule, message: s.message });
    for (const s of this.raster.skipped) o.onRasterSkipped?.({ rasterId: s.id, ...SKIP_TEXT[s.reason] });
  }

  /**
   * `update({ georeference })`: new positions for the quads and a new tessellation of the strokes through the upload budget.
   * Textures, bitmaps and decodes in flight stay valid, because a decode does not depend on the transform.
   */
  setReference(reference: GeoReference | undefined): void {
    this.reference = reference;
    this.transformEpoch++;
    this.makeRaster();
    this.raster?.setTransformEpoch(this.transformEpoch);
    if (this.lastDraws) this.setDraws(this.lastDraws);
    this.o.map.triggerRepaint?.();
  }

  /** The rasters that draw, with their attribution escaped for an HTML sink. */
  rasterInfos(): RasterInfo[] {
    return (this.raster?.live() ?? []).map((p) => ({
      id: p.id,
      width: p.width,
      height: p.height,
      band: p.band,
      opacity: p.opacity,
      attribution: p.attribution ? escapeAttribution(p.attribution) : "",
    }));
  }

  /** The raster counters of the snapshot. */
  rasterAccounting(): { textureBytes: number; decodesInFlight: number } {
    return { textureBytes: this.o.cache.bytes("gpu"), decodesInFlight: this.lastRasterStats?.decodesInFlight ?? 0 };
  }

  /** `raster.enabled` at runtime: off draws no raster and starts no decode, on picks up where the cache left off. */
  setRasterEnabled(on: boolean): void {
    this.rasterOn = on;
    this.o.map.triggerRepaint?.();
  }

  /** Pack the draws per style group into the pool. Only straight and polyline geometry is drawn here. */
  setDraws(draws: readonly EntityDraw[]): void {
    this.lastDraws = draws;
    const pool = (this.pool ??= new BufferPool(this.tgl, { guardBytes: 40 }));
    for (const g of this.groups) pool.remove(g.key);
    this.groups = [];
    if (!this.reference) return;
    const geo = createGeoTransform(this.reference);
    const byKey = new Map<string, { g: Group; parts: Uint8Array[] }>();
    for (const d of draws) {
      if (d.geometry.type !== "line" && d.geometry.type !== "polyline") {
        this.skipped++;
        continue;
      }
      if (!this.o.visible(d.entityId)) continue;
      const st = this.o.style(d.entityId);
      const key = JSON.stringify([st.color, st.widthPx, st.dash]);
      let e = byKey.get(key);
      if (!e) {
        const dash = st.dash.length >= 2 ? ([st.dash[0]!, st.dash[1]!] as [number, number]) : undefined;
        byKey.set(key, (e = { g: { key: `g${byKey.size}`, color: parseColor(st.color), widthCss: st.widthPx, dash }, parts: [] }));
      }
      const src = d.geometry.points;
      const world: number[] = [];
      for (let i = 0; i + 1 < src.length; i += 2) world.push(...sourceToWorld(geo, src[i]!, src[i + 1]!));
      const packed = packPolyline(world, { widthIndex: 0, dashIndex: e.g.dash ? 1 : 0, flags: 0 });
      if (packed.count) e.parts.push(new Uint8Array(packed.data));
    }
    for (const { g, parts } of byKey.values()) {
      if (!parts.length) continue;
      const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of parts) (all.set(p, at), (at += p.byteLength));
      pool.add(g.key, all);
      this.groups.push(g);
    }
    this.o.map.triggerRepaint?.();
  }

  render(): void {
    const { gl } = this;
    const map = this.o.map;
    if (this.lost || (!this.groups.length && !(this.rasterOn && this.raster?.drawsAnything)) || gl.isContextLost()) return;
    if (typeof map.project !== "function" || typeof map.unproject !== "function") return;
    const view = this.view();
    if (!view) return;
    const diffs = this.guard.run(() => {
      const pool = this.pool;
      if (pool) {
        pool.beginFrame(++this.frame);
        pool.flush();
      }
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const raster = this.rasterOn ? this.raster : undefined;
      const rf = raster ? this.rasterFrame(view) : undefined;
      // Band 0 rasters, then the strokes, then band 1 rasters: the raster is drawn through the same chain as the strokes.
      if (raster && rf) (raster.prepare(rf), raster.draw(0, rf));
      if (pool) {
        this.renderer ??= new StrokeRenderer(this.tgl);
        // One object per frame for the camera fields: the stroke renderer sets those uniforms once for all the ranges of a frame.
        const cam = {
          centerHi: [view.cx.hi, view.cy.hi] as [number, number],
          centerLo: [view.cx.lo, view.cy.lo] as [number, number],
          linear: view.linear,
          viewport: [gl.drawingBufferWidth, gl.drawingBufferHeight] as [number, number],
          dpr: view.dpr,
        };
        for (const g of this.groups) {
          const range = pool.range(g.key);
          if (!range) continue;
          this.renderer.draw(range, {
            ...cam,
            widthsPx: [g.widthCss * view.dpr],
            dashes: g.dash ? [[g.dash[0] * view.dpr, g.dash[1] * view.dpr, 0, 0]] : [],
            arcToPx: view.arcToPx,
            color: g.color,
          });
        }
        pool.completeFrame(this.frame);
      }
      if (raster && rf) (raster.draw(1, rf), raster.endFrame());
    });
    if (this.o.onStateDiff) this.o.onStateDiff(diffs.map((d) => d.name));
    if ((this.pool?.accounting().queuedBytes ?? 0) > 0) map.triggerRepaint?.();
  }

  /** Centre of the viewport in mercator, and device px (y up) per mercator unit, from the map's own projection. */
  private view() {
    const { gl } = this;
    const map = this.o.map;
    const cssW = map.getCanvas().clientWidth, cssH = map.getCanvas().clientHeight;
    if (!(cssW > 0 && cssH > 0)) return undefined;
    const c = map.unproject([cssW / 2, cssH / 2]);
    const [cx, cy] = lngLatToMercator(c.lng, c.lat);
    const step = 64 / (512 * 2 ** map.getZoom());
    const at = (mx: number, my: number): [number, number] => {
      const p = map.project(mercatorToLngLat(mx, my));
      return [p.x, p.y];
    };
    const o = at(cx, cy), ex = at(cx + step, cy), ey = at(cx, cy + step);
    const dpr = gl.drawingBufferWidth / cssW;
    const a = (ex[0] - o[0]) / step, b = (ex[1] - o[1]) / step, cc = (ey[0] - o[0]) / step, d = (ey[1] - o[1]) / step;
    if (![a, b, cc, d].every(Number.isFinite)) return undefined;
    return {
      cx: splitHiLo(cx),
      cy: splitHiLo(cy),
      dpr,
      linear: [dpr * a, -dpr * b, dpr * cc, -dpr * d] as [number, number, number, number],
      arcToPx: dpr * Math.hypot(a, b),
    };
  }

  /** What the raster pass needs of the camera, derived from the same view and the map's own projection. */
  private rasterFrame(view: { cx: { hi: number; lo: number }; cy: { hi: number; lo: number }; dpr: number; linear: [number, number, number, number] }): RasterFrame | undefined {
    const { gl } = this;
    const map = this.o.map;
    const reference = this.reference;
    if (!reference) return undefined;
    const geo = createGeoTransform(reference);
    const dpr = view.dpr;
    const at = (x: number, y: number): [number, number] => {
      const p = map.project(mercatorToLngLat(...sourceToWorld(geo, x, y)));
      return [p.x * dpr, p.y * dpr];
    };
    return {
      centerHi: [view.cx.hi, view.cy.hi],
      centerLo: [view.cx.lo, view.cy.lo],
      linear: view.linear,
      viewport: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      dpr,
      sourceToWorld: (x, y) => sourceToWorld(geo, x, y),
      sourceToDevice: (sx, sy, span) => {
        const o = at(sx, sy), ex = at(sx + span, sy), ey = at(sx, sy + span);
        const a = (ex[0] - o[0]) / span, c = (ex[1] - o[1]) / span, b = (ey[0] - o[0]) / span, d = (ey[1] - o[1]) / span;
        return [a, b, c, d, o[0] - a * sx - b * sy, o[1] - c * sx - d * sy];
      },
    };
  }

  /** The GL objects are gone; decoded bytes stay in the pool, so nothing is fetched or decoded again. */
  onContextLost(): void {
    this.lost = true;
    this.raster?.onContextLost();
    this.renderer = undefined;
    this.pool?.dropGlHandles();
  }
  onContextRestored(): void {
    this.lost = false;
    this.guard.invalidate();
    this.pool?.rebind(this.tgl);
    this.o.map.triggerRepaint?.();
  }

  dispose(): void {
    this.raster?.dispose();
    this.renderer?.dispose();
    this.pool?.dispose();
    this.renderer = undefined;
    this.pool = undefined;
    this.groups = [];
  }
}
