import { BufferPool } from "../../src/render/buffer_pool";
import { packPolyline, splitHiLo } from "../../src/render/buffer_layout";
import { StrokeRenderer } from "../../src/render/stroke/renderer";
import { percentile } from "../lib/stats";

// Page side of the hardware run (#82). Draws the existing stroke pipeline through the existing
// pool, 1e6 segments per frame as ten 100k-segment ranges, and reports raw timings. Bundled to an
// IIFE (window.HW) by bench/hw/run.mjs and driven by Playwright.
const POLYLINES = 10;
const SEG_PER_LINE = 100_000;
const CSS_W = 1600;
const CSS_H = 1000;

function walk(seed: number, n: number, w: number, h: number): number[] {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const pts: number[] = [];
  let x = rnd() * w, y = rnd() * h, a = rnd() * 6.283;
  for (let i = 0; i <= n; i++) {
    pts.push(x, y);
    a += (rnd() - 0.5) * 1.2;
    const step = 2 + rnd() * 4;
    x += Math.cos(a) * step; y += Math.sin(a) * step;
    if (x < 0 || x > w) { x = Math.min(Math.max(x, 0), w); a = Math.PI - a; }
    if (y < 0 || y > h) { y = Math.min(Math.max(y, 0), h); a = -a; }
  }
  return pts;
}

const sha256 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((v) => v.toString(16).padStart(2, "0")).join("");
const stats = (v: number[]) => ({ p50: percentile(v, 50), p95: percentile(v, 95), p99: percentile(v, 99), max: Math.max(...v) });

function context(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.style.cssText = `width:${w / devicePixelRatio}px;height:${h / devicePixelRatio}px`;
  document.body.appendChild(canvas);
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false, alpha: true, stencil: true })!;
  return { canvas, gl };
}

function scene(gl: WebGL2RenderingContext, lines: number, segs: number, w: number, h: number, seedBase: number) {
  const pool = new BufferPool(gl, { guardBytes: 40, uploadBudgetBytes: Infinity, uploadBudgetMs: Infinity });
  const renderer = new StrokeRenderer(gl);
  for (let i = 0; i < lines; i++) pool.add(`l${i}`, new Uint8Array(packPolyline(walk(seedBase + i, segs, w, h), { widthIndex: 0, dashIndex: 0, flags: 0 }).data));
  return { pool, renderer };
}

function drawAll(gl: WebGL2RenderingContext, pool: BufferPool, renderer: StrokeRenderer, lines: number, w: number, h: number, dpr: number, pan: number) {
  const cx = splitHiLo(w / 2 + pan), cy = splitHiLo(h / 2);
  gl.viewport(0, 0, w * dpr, h * dpr);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  for (let i = 0; i < lines; i++) {
    renderer.draw(pool.range(`l${i}`)!, {
      centerHi: [cx.hi, cy.hi], centerLo: [cx.lo, cy.lo], linear: [dpr, 0, 0, -dpr], viewport: [w * dpr, h * dpr],
      dpr, widthsPx: [1.5 * dpr], arcToPx: dpr,
    });
  }
}

export async function run(o: { durationMs: number; warmupMs: number }) {
  const dpr = devicePixelRatio;
  const { canvas, gl } = context(CSS_W * dpr, CSS_H * dpr);
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuRenderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const gpuVendor = String(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));

  // Draw-call counter around the one call the stroke renderer makes per range.
  let calls = 0;
  const orig = gl.drawArraysInstanced.bind(gl);
  gl.drawArraysInstanced = ((...a: Parameters<typeof orig>) => { calls++; return orig(...a); }) as typeof orig;

  // 1e6-segment scene: upload (pool.flush then finish), then synchronous draw timings.
  const { pool, renderer } = scene(gl, POLYLINES, SEG_PER_LINE, CSS_W, CSS_H, 1);
  const px1 = new Uint8Array(4);
  const t0 = performance.now();
  pool.flush();
  gl.finish();
  const uploadMs = performance.now() - t0;
  gl.clearColor(0, 0, 0, 0);
  const syncDraw: number[] = [];
  for (let i = -5; i < 30; i++) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    const s = performance.now();
    drawAll(gl, pool, renderer, POLYLINES, CSS_W, CSS_H, dpr, 0);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
    if (i >= 0) syncDraw.push(performance.now() - s);
  }

  // Upload curve: bufferSubData of N bytes into a scratch buffer, finish, per size.
  const upload: Array<{ bytes: number; p50Ms: number; p95Ms: number }> = [];
  const scratch = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
  gl.bufferData(gl.ARRAY_BUFFER, 16 << 20, gl.STATIC_DRAW);
  for (const bytes of [256 << 10, 1 << 20, 2 << 20, 4 << 20, 8 << 20, 16 << 20]) {
    const src = new Uint8Array(bytes).fill(7);
    const t: number[] = [];
    for (let i = -3; i < 25; i++) {
      const s = performance.now();
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, src);
      gl.finish();
      if (i >= 0) t.push(performance.now() - s);
    }
    upload.push({ bytes, p50Ms: percentile(t, 50), p95Ms: percentile(t, 95) });
  }
  gl.deleteBuffer(scratch);

  // The 60 s frame loop: pan the whole scene, one frame per rAF.
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const pending: WebGLQuery[] = [];
  const gpuMs: number[] = [];
  const pollTimers = () => {
    while (pending.length) {
      const q = pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(timer!.GPU_DISJOINT_EXT)) gpuMs.push(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
      gl.deleteQuery(q); pending.shift();
    }
  };
  const interval: number[] = [], submit: number[] = [], perFrameCalls: number[] = [];
  await new Promise<void>((resolve) => {
    let last = 0, start = 0, frame = 0;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const elapsed = ts - start;
      const recording = elapsed >= o.warmupMs;
      const before = calls;
      const s = performance.now();
      const q = timer && pending.length < 8 ? gl.createQuery()! : null;
      if (q) gl.beginQuery(timer!.TIME_ELAPSED_EXT, q);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawAll(gl, pool, renderer, POLYLINES, CSS_W, CSS_H, dpr, Math.sin(frame++ / 60) * 200);
      if (q) { gl.endQuery(timer!.TIME_ELAPSED_EXT); pending.push(q); }
      const cpu = performance.now() - s;
      if (timer) pollTimers();
      if (recording && last) { interval.push(ts - last); submit.push(cpu); perFrameCalls.push(calls - before); }
      last = ts;
      if (elapsed < o.warmupMs + o.durationMs) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  const recordedMs = interval.reduce((a, b) => a + b, 0);

  // Snapshot scene: fixed 256x256 device px, dpr 1 maths, hashed per renderer string.
  const snap = context(256, 256);
  const sp = scene(snap.gl, 1, 400, 256, 256, 77);
  sp.pool.flush();
  snap.gl.clearColor(0, 0, 0, 0); snap.gl.clear(snap.gl.COLOR_BUFFER_BIT);
  drawAll(snap.gl, sp.pool, sp.renderer, 1, 256, 256, 1, 0);
  const img = new Uint8Array(256 * 256 * 4);
  snap.gl.readPixels(0, 0, 256, 256, snap.gl.RGBA, snap.gl.UNSIGNED_BYTE, img);
  const glError = gl.getError() + snap.gl.getError();

  const fs = stats(interval), cs = stats(submit);
  return {
    gpuRenderer, gpuVendor, dpr, viewport: [CSS_W, CSS_H] as [number, number], timerQuery: !!timer, glError,
    frames: { durationMs: Math.round(recordedMs), count: interval.length, p50Ms: fs.p50, p95Ms: fs.p95, p99Ms: fs.p99, maxMs: fs.max, over20Ms: interval.filter((v) => v > 20).length },
    drawCalls: { perFrame: percentile(perFrameCalls, 50), segmentsPerFrame: POLYLINES * SEG_PER_LINE },
    cpu: { submitP50Ms: cs.p50, submitP95Ms: cs.p95, submitMaxMs: cs.max },
    gpu: gpuMs.length ? { frameP50Ms: percentile(gpuMs, 50), frameP95Ms: percentile(gpuMs, 95) } : null,
    draw1e6: { segments: POLYLINES * SEG_PER_LINE, uploadMs, syncDrawP50Ms: percentile(syncDraw, 50), syncDrawP95Ms: percentile(syncDraw, 95) },
    upload,
    snapshot: { scene: "walk-400-seed77-256px-v1", sha256: await sha256(img) },
    canvasCss: [canvas.style.width, canvas.style.height],
  };
}
