import { BufferPool } from '../../../src/render/buffer_pool';
import { packPolyline, splitHiLo } from '../../../src/render/buffer_layout';
import { StrokeRenderer } from '../../../src/render/stroke/renderer';
import { GlStateGuard } from '../../../src/render/gl_state';

export interface Scene {
  size: number; // css px, square
  lines: Array<{ points: number[]; widthCss: number; flags?: number; dash?: [number, number] }>;
  miterLimit?: number;
  loseContext?: boolean;
}

/** Render a scene and return the alpha channel (device px, top-down) plus GL bookkeeping. */
export function render(scene: Scene) {
  const dpr = window.devicePixelRatio;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(scene.size * dpr); canvas.height = Math.round(scene.size * dpr);
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true, stencil: true })!;
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  const pool = new BufferPool(gl, { guardBytes: 40, uploadBudgetBytes: Infinity, uploadBudgetMs: Infinity });
  const r = new StrokeRenderer(gl);
  const c = scene.size / 2, cx = splitHiLo(c);
  scene.lines.forEach((l, i) => {
    const packed = packPolyline(l.points, { widthIndex: i, dashIndex: l.dash ? i + 1 : 0, flags: l.flags ?? 0 });
    pool.add(`l${i}`, new Uint8Array(packed.data));
  });
  pool.flush();
  const guard = new GlStateGuard(gl, { debug: true });
  const diffs = guard.run(() => {
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, canvas.width, canvas.height);
    scene.lines.forEach((l, i) => {
      const widthsPx: number[] = []; widthsPx[i] = l.widthCss * dpr;
      const dashes: Array<[number, number, number, number]> = [];
      if (l.dash) dashes[i] = [l.dash[0] * dpr, l.dash[1] * dpr, 0, 0];
      const filled = Array.from({ length: i + 1 }, (_, k) => dashes[k] ?? [0, 0, 0, 0] as [number, number, number, number]);
      r.draw(pool.range(`l${i}`)!, {
        centerHi: [cx.hi, cx.hi], centerLo: [cx.lo, cx.lo], linear: [dpr, 0, 0, -dpr], viewport: [canvas.width, canvas.height],
        dpr, widthsPx, dashes: filled, arcToPx: dpr, miterLimit: scene.miterLimit,
      });
    });
  });
  const px = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const alpha: number[] = [];
  for (let y = canvas.height - 1; y >= 0; y--) for (let x = 0; x < canvas.width; x++) alpha.push(px[(y * canvas.width + x) * 4 + 3]!);
  const err = gl.getError();
  const stateDiffs = diffs.map((d) => d.name);
  pool.dispose(); r.dispose();
  return { w: canvas.width, h: canvas.height, alpha, glError: err, stateDiffs, dpr, renderer: (gl.getParameter(gl.RENDERER) as string) };
}
