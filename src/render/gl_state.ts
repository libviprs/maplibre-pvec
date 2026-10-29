type Gl = WebGL2RenderingContext;
export type StateGroup = 'program' | 'vao' | 'buffer' | 'texture' | 'blend' | 'depth' | 'stencil' | 'cull' | 'scissor' | 'viewport' | 'colorMask' | 'unpack';
export interface StateDiff { name: string; before: unknown; after: unknown }
type Snapshot = Map<string, { group: StateGroup; value: unknown }>;

const FRONT = 0x0404, BACK = 0x0405, TEXTURE0 = 0x84c0;

const norm = (v: unknown): unknown => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v);

/**
 * Saves and restores exactly the GL state the add-on touches, so MapLibre's own layers see
 * the state they left. In debug mode the full captured vector is diffed before and after.
 */
export class GlStateGuard {
  private readonly skip: ReadonlySet<StateGroup>;
  private readonly debug: boolean;
  private readonly units: readonly number[];

  constructor(private readonly gl: Gl, o: { debug?: boolean; skip?: StateGroup[]; textureUnits?: number[] } = {}) {
    this.debug = o.debug ?? false;
    this.skip = new Set(o.skip ?? []);
    this.units = o.textureUnits ?? [0];
  }

  /** Run `fn`, restore the state, and return the debug diff (always empty when debug is off). */
  run(fn: () => void): StateDiff[] {
    const before = this.capture();
    try { fn(); } finally { this.restore(before); }
    return this.debug ? diff(before, this.capture()) : [];
  }

  capture(): Snapshot {
    const gl = this.gl;
    const s: Snapshot = new Map();
    const put = (name: string, group: StateGroup, value: unknown) => s.set(name, { group, value: norm(value) });
    const cap = (name: string, group: StateGroup, c: number | undefined) => { if (c !== undefined) put(name, group, gl.isEnabled(c)); };
    const par = (name: string, group: StateGroup) => {
      const p = (gl as unknown as Record<string, number | undefined>)[name];
      if (p !== undefined) put(name, group, gl.getParameter(p));
    };
    cap('BLEND', 'blend', gl.BLEND); cap('DEPTH_TEST', 'depth', gl.DEPTH_TEST); cap('STENCIL_TEST', 'stencil', gl.STENCIL_TEST);
    cap('CULL_FACE', 'cull', gl.CULL_FACE); cap('SCISSOR_TEST', 'scissor', gl.SCISSOR_TEST);
    par('CURRENT_PROGRAM', 'program'); par('VERTEX_ARRAY_BINDING', 'vao'); par('ARRAY_BUFFER_BINDING', 'buffer');
    for (const n of ['BLEND_SRC_RGB', 'BLEND_DST_RGB', 'BLEND_SRC_ALPHA', 'BLEND_DST_ALPHA', 'BLEND_EQUATION_RGB', 'BLEND_EQUATION_ALPHA']) par(n, 'blend');
    for (const n of ['DEPTH_WRITEMASK', 'DEPTH_FUNC']) par(n, 'depth');
    for (const n of ['STENCIL_FUNC', 'STENCIL_REF', 'STENCIL_VALUE_MASK', 'STENCIL_WRITEMASK', 'STENCIL_FAIL', 'STENCIL_PASS_DEPTH_FAIL', 'STENCIL_PASS_DEPTH_PASS',
      'STENCIL_BACK_FUNC', 'STENCIL_BACK_REF', 'STENCIL_BACK_VALUE_MASK', 'STENCIL_BACK_WRITEMASK', 'STENCIL_BACK_FAIL', 'STENCIL_BACK_PASS_DEPTH_FAIL', 'STENCIL_BACK_PASS_DEPTH_PASS']) par(n, 'stencil');
    for (const n of ['CULL_FACE_MODE', 'FRONT_FACE']) par(n, 'cull');
    par('SCISSOR_BOX', 'scissor'); par('VIEWPORT', 'viewport'); par('COLOR_WRITEMASK', 'colorMask');
    for (const n of ['UNPACK_FLIP_Y_WEBGL', 'UNPACK_PREMULTIPLY_ALPHA_WEBGL', 'UNPACK_ALIGNMENT', 'UNPACK_COLORSPACE_CONVERSION_WEBGL', 'UNPACK_ROW_LENGTH', 'UNPACK_SKIP_ROWS', 'UNPACK_SKIP_PIXELS', 'UNPACK_IMAGE_HEIGHT', 'UNPACK_SKIP_IMAGES']) par(n, 'unpack');
    if (gl.ACTIVE_TEXTURE !== undefined) {
      const active = gl.getParameter(gl.ACTIVE_TEXTURE);
      put('ACTIVE_TEXTURE', 'texture', active);
      for (const u of this.units) {
        gl.activeTexture(TEXTURE0 + u);
        put(`TEXTURE_BINDING_2D[${u}]`, 'texture', gl.getParameter(gl.TEXTURE_BINDING_2D));
      }
      gl.activeTexture(active as number);
    }
    return s;
  }

  restore(s: Snapshot): void {
    const gl = this.gl;
    const v = (n: string) => s.get(n)?.value;
    const on = (g: StateGroup) => !this.skip.has(g);
    const en = (c: number | undefined, val: unknown) => { if (c === undefined) return; if (val) gl.enable(c); else gl.disable(c); };
    if (on('blend')) {
      en(gl.BLEND, v('BLEND'));
      const sa = v('BLEND_SRC_ALPHA') as number | undefined;
      if (gl.blendFuncSeparate && sa !== undefined) gl.blendFuncSeparate(v('BLEND_SRC_RGB') as number, v('BLEND_DST_RGB') as number, sa, v('BLEND_DST_ALPHA') as number);
      else gl.blendFunc(v('BLEND_SRC_RGB') as number, v('BLEND_DST_RGB') as number);
      const ea = v('BLEND_EQUATION_ALPHA') as number | undefined;
      if (gl.blendEquationSeparate && ea !== undefined) gl.blendEquationSeparate(v('BLEND_EQUATION_RGB') as number, ea);
      else gl.blendEquation(v('BLEND_EQUATION_RGB') as number);
    }
    if (on('depth')) { en(gl.DEPTH_TEST, v('DEPTH_TEST')); gl.depthMask(v('DEPTH_WRITEMASK') as boolean); gl.depthFunc(v('DEPTH_FUNC') as number); }
    if (on('stencil')) {
      en(gl.STENCIL_TEST, v('STENCIL_TEST'));
      if (gl.stencilFuncSeparate && v('STENCIL_BACK_FUNC') !== undefined) {
        gl.stencilFuncSeparate(FRONT, v('STENCIL_FUNC') as number, v('STENCIL_REF') as number, v('STENCIL_VALUE_MASK') as number);
        gl.stencilFuncSeparate(BACK, v('STENCIL_BACK_FUNC') as number, v('STENCIL_BACK_REF') as number, v('STENCIL_BACK_VALUE_MASK') as number);
        gl.stencilMaskSeparate(FRONT, v('STENCIL_WRITEMASK') as number);
        gl.stencilMaskSeparate(BACK, v('STENCIL_BACK_WRITEMASK') as number);
        gl.stencilOpSeparate(FRONT, v('STENCIL_FAIL') as number, v('STENCIL_PASS_DEPTH_FAIL') as number, v('STENCIL_PASS_DEPTH_PASS') as number);
        gl.stencilOpSeparate(BACK, v('STENCIL_BACK_FAIL') as number, v('STENCIL_BACK_PASS_DEPTH_FAIL') as number, v('STENCIL_BACK_PASS_DEPTH_PASS') as number);
      } else {
        gl.stencilFunc(v('STENCIL_FUNC') as number, v('STENCIL_REF') as number, v('STENCIL_VALUE_MASK') as number);
        gl.stencilMask(v('STENCIL_WRITEMASK') as number);
      }
    }
    if (on('cull')) {
      en(gl.CULL_FACE, v('CULL_FACE'));
      if (v('CULL_FACE_MODE') !== undefined) { gl.cullFace(v('CULL_FACE_MODE') as number); gl.frontFace(v('FRONT_FACE') as number); }
    }
    if (on('scissor')) { en(gl.SCISSOR_TEST, v('SCISSOR_TEST')); const b = v('SCISSOR_BOX') as number[]; gl.scissor(b[0]!, b[1]!, b[2]!, b[3]!); }
    if (on('viewport')) { const b = v('VIEWPORT') as number[]; gl.viewport(b[0]!, b[1]!, b[2]!, b[3]!); }
    if (on('colorMask')) { const m = v('COLOR_WRITEMASK') as boolean[]; gl.colorMask(m[0]!, m[1]!, m[2]!, m[3]!); }
    if (on('unpack')) {
      for (const [n, e] of s) if (e.group === 'unpack') gl.pixelStorei((gl as unknown as Record<string, number>)[n]!, e.value as number);
    }
    if (on('texture') && s.has('ACTIVE_TEXTURE')) {
      for (const u of this.units) { gl.activeTexture(TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, v(`TEXTURE_BINDING_2D[${u}]`) as WebGLTexture | null); }
      gl.activeTexture(v('ACTIVE_TEXTURE') as number);
    }
    if (on('buffer')) gl.bindBuffer(gl.ARRAY_BUFFER, v('ARRAY_BUFFER_BINDING') as WebGLBuffer | null);
    if (on('vao')) gl.bindVertexArray(v('VERTEX_ARRAY_BINDING') as WebGLVertexArrayObject | null);
    if (on('program')) gl.useProgram(v('CURRENT_PROGRAM') as WebGLProgram | null);
  }
}

function diff(a: Snapshot, b: Snapshot): StateDiff[] {
  const out: StateDiff[] = [];
  for (const [name, e] of a) {
    const o = b.get(name);
    const same = Array.isArray(e.value) ? JSON.stringify(e.value) === JSON.stringify(o?.value) : e.value === o?.value;
    if (!same) out.push({ name, before: e.value, after: o?.value });
  }
  return out;
}

/** Request a repaint only while work is pending, so an idle map renders no extra frames. */
export class RepaintScheduler {
  constructor(private readonly trigger: () => void, private readonly pending: () => number) {}
  afterRender(): void { if (this.pending() > 0) this.trigger(); }
}

/** Drop GL handles on loss (keeping decoded data), rebuild on restore, then repaint. */
export function watchContextLoss(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  h: { onLost: () => void; onRestored: () => void; repaint: () => void },
): () => void {
  const lost = (e: Event) => { e.preventDefault(); h.onLost(); };
  const restored = () => { h.onRestored(); h.repaint(); };
  target.addEventListener('webglcontextlost', lost);
  target.addEventListener('webglcontextrestored', restored);
  return () => { target.removeEventListener('webglcontextlost', lost); target.removeEventListener('webglcontextrestored', restored); };
}
