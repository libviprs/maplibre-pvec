type Gl = WebGL2RenderingContext;
export type StateGroup = 'program' | 'vao' | 'buffer' | 'texture' | 'blend' | 'depth' | 'stencil' | 'cull' | 'scissor' | 'viewport' | 'colorMask' | 'unpack';
export interface StateDiff { name: string; before: unknown; after: unknown }
type Snapshot = Map<string, { group: StateGroup; value: unknown }>;

const FRONT = 0x0404, BACK = 0x0405, TEXTURE0 = 0x84c0;

const norm = (v: unknown): unknown => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v);

type Setter = (...a: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Shadow of the GL state, kept current by wrapping the context's own setters. A getParameter is a round trip to the GPU
 * process in Chromium (the first one waits for the whole previous frame), so the guard reads the real state once to seed
 * the shadow and from then on only listens to the calls that change it, MapLibre's and ours alike.
 */
class Shadow {
  readonly state: Snapshot = new Map();
  seeded = false;
  private installed = false;
  private active = 0x84c0;

  constructor(private readonly gl: Gl) {}

  seed(snap: Snapshot): void {
    this.state.clear();
    for (const [k, v] of snap) this.state.set(k, { group: v.group, value: v.value });
    const a = snap.get('ACTIVE_TEXTURE')?.value;
    this.active = typeof a === 'number' ? a : TEXTURE0;
    this.seeded = true;
    this.install();
  }

  copy(): Snapshot {
    const s: Snapshot = new Map();
    for (const [k, v] of this.state) s.set(k, { group: v.group, value: v.value });
    return s;
  }

  private set(name: string, value: unknown): void {
    const e = this.state.get(name);
    if (e) e.value = value;
  }

  /** Forget a deleted object, which GL unbinds implicitly. */
  private drop(group: StateGroup, h: unknown): void {
    if (h == null) return;
    for (const e of this.state.values()) if (e.group === group && e.value === h) e.value = null;
  }

  private install(): void {
    if (this.installed) return;
    this.installed = true;
    const gl = this.gl as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const wrap = (name: string, on: (...a: any[]) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const orig = gl[name] as Setter | undefined;
      if (typeof orig !== 'function') return;
      gl[name] = function (this: unknown, ...a: unknown[]) { on(...a); return orig.apply(gl, a); };
    };
    const caps = new Map<number, string>();
    for (const n of ['BLEND', 'DEPTH_TEST', 'STENCIL_TEST', 'CULL_FACE', 'SCISSOR_TEST']) if (gl[n] !== undefined) caps.set(gl[n] as number, n);
    wrap('enable', (c) => { const n = caps.get(c); if (n) this.set(n, true); });
    wrap('disable', (c) => { const n = caps.get(c); if (n) this.set(n, false); });
    const blendFunc = (sr: number, dr: number, sa: number, da: number) => {
      this.set('BLEND_SRC_RGB', sr); this.set('BLEND_DST_RGB', dr); this.set('BLEND_SRC_ALPHA', sa); this.set('BLEND_DST_ALPHA', da);
    };
    wrap('blendFunc', (s, d) => blendFunc(s, d, s, d));
    wrap('blendFuncSeparate', blendFunc);
    wrap('blendEquation', (m) => { this.set('BLEND_EQUATION_RGB', m); this.set('BLEND_EQUATION_ALPHA', m); });
    wrap('blendEquationSeparate', (r, a) => { this.set('BLEND_EQUATION_RGB', r); this.set('BLEND_EQUATION_ALPHA', a); });
    wrap('depthMask', (m) => this.set('DEPTH_WRITEMASK', m));
    wrap('depthFunc', (f) => this.set('DEPTH_FUNC', f));
    const faces = (face: number) => (face === FRONT ? [''] : face === BACK ? ['BACK_'] : ['', 'BACK_']);
    wrap('stencilFuncSeparate', (face, f, r, m) => { for (const p of faces(face)) { this.set(`STENCIL_${p}FUNC`, f); this.set(`STENCIL_${p}REF`, r); this.set(`STENCIL_${p}VALUE_MASK`, m); } });
    wrap('stencilFunc', (f, r, m) => { for (const p of ['', 'BACK_']) { this.set(`STENCIL_${p}FUNC`, f); this.set(`STENCIL_${p}REF`, r); this.set(`STENCIL_${p}VALUE_MASK`, m); } });
    wrap('stencilMaskSeparate', (face, m) => { for (const p of faces(face)) this.set(`STENCIL_${p}WRITEMASK`, m); });
    wrap('stencilMask', (m) => { for (const p of ['', 'BACK_']) this.set(`STENCIL_${p}WRITEMASK`, m); });
    const ops = (face: number, f: number, zf: number, zp: number) => { for (const p of faces(face)) { this.set(`STENCIL_${p}FAIL`, f); this.set(`STENCIL_${p}PASS_DEPTH_FAIL`, zf); this.set(`STENCIL_${p}PASS_DEPTH_PASS`, zp); } };
    wrap('stencilOpSeparate', ops);
    wrap('stencilOp', (f, zf, zp) => ops(0x0408, f, zf, zp));
    wrap('cullFace', (m) => this.set('CULL_FACE_MODE', m));
    wrap('frontFace', (m) => this.set('FRONT_FACE', m));
    wrap('scissor', (x, y, w, h) => this.set('SCISSOR_BOX', [x, y, w, h]));
    wrap('viewport', (x, y, w, h) => this.set('VIEWPORT', [x, y, w, h]));
    wrap('colorMask', (r, g, b, a) => this.set('COLOR_WRITEMASK', [r, g, b, a]));
    const unpack = new Map<number, string>();
    for (const [k, e] of this.state) if (e.group === 'unpack' && gl[k] !== undefined) unpack.set(gl[k] as number, k);
    wrap('pixelStorei', (p, v) => { const n = unpack.get(p); if (n) this.set(n, v); });
    wrap('useProgram', (p) => this.set('CURRENT_PROGRAM', p));
    wrap('bindVertexArray', (v) => this.set('VERTEX_ARRAY_BINDING', v));
    wrap('bindBuffer', (t, b) => { if (t === gl.ARRAY_BUFFER) this.set('ARRAY_BUFFER_BINDING', b); });
    wrap('activeTexture', (u) => { this.active = u; this.set('ACTIVE_TEXTURE', u); });
    wrap('bindTexture', (t, tex) => { if (t === gl.TEXTURE_2D) this.set(`TEXTURE_BINDING_2D[${this.active - TEXTURE0}]`, tex); });
    wrap('deleteProgram', (h) => this.drop('program', h));
    wrap('deleteVertexArray', (h) => this.drop('vao', h));
    wrap('deleteBuffer', (h) => this.drop('buffer', h));
    wrap('deleteTexture', (h) => { for (const [k, e] of this.state) if (k.startsWith('TEXTURE_BINDING_2D') && e.value === h) e.value = null; });
  }
}

const shadows = new WeakMap<object, Shadow>();

/**
 * Saves and restores exactly the GL state the add-on touches, so MapLibre's own layers see
 * the state they left. The first frame reads the state back once; after that the state comes from a shadow
 * kept by the context's setters, so a steady-state frame issues no blocking reads. In debug mode the full
 * captured vector is still queried and diffed before and after.
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

  /** Forget the shadow, so the next frame reads the real state again (after a context restore, or any bypass of the setters). */
  invalidate(): void {
    const sh = shadows.get(this.gl);
    if (sh) sh.seeded = false;
  }

  private shadow(): Shadow {
    let sh = shadows.get(this.gl);
    if (!sh) shadows.set(this.gl, (sh = new Shadow(this.gl)));
    return sh;
  }

  /** Run `fn`, restore the state, and return the debug diff (always empty when debug is off). */
  run(fn: () => void): StateDiff[] {
    if (this.debug) {
      const before = this.capture();
      try { fn(); } finally { this.restore(before); }
      return diff(before, this.capture());
    }
    const sh = this.shadow();
    if (!sh.seeded || this.units.some((u) => !sh.state.has(`TEXTURE_BINDING_2D[${u}]`))) sh.seed(this.capture());
    const before = sh.copy();
    try { fn(); } finally { this.restore(before); }
    return [];
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
