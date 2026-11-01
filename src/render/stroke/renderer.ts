import { SEGMENT_RECORD_BYTES } from '../buffer_layout';
import { DEFAULTS } from '../../config/defaults';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shaders';

export interface DrawParams {
  centerHi: [number, number];
  centerLo: [number, number];
  /** Column-major 2x2: device px per source unit. */
  linear: [number, number, number, number];
  viewport: [number, number];
  dpr: number;
  widthsPx: number[];
  /** Dash table entries (on, off, on2, off2) in device px; entry i serves dash index i + 1. */
  dashes?: Array<[number, number, number, number]>;
  arcToPx?: number;
  color?: [number, number, number, number];
  miterLimit?: number | undefined;
}
export interface Range { buffer: WebGLBuffer; offset: number; length: number }

const MAX_VAOS = 256;

/** Draws packed segment ranges with the stroke program. One VAO per range, made on first use. */
export class StrokeRenderer {
  private program: WebGLProgram | null;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly loc: Record<string, number> = {};
  /**
   * One VAO per (buffer, offset) of a range, set up the first time the range is drawn: its attribute arrays, divisors and pointers then
   * stay on the VAO and a draw binds it with one call. The table is emptied (and the VAOs deleted) when it grows past `MAX_VAOS`, which
   * only happens when the pool keeps making new buffers or offsets.
   */
  private readonly vaos = new Map<WebGLBuffer, Map<number, WebGLVertexArrayObject>>();
  private vaoCount = 0;
  private lastWidths = new Float32Array(64);
  private lastDashes = new Float32Array(64);
  private lastColor: [number, number, number, number] | undefined;
  private widthsSet = false;
  /** The uniforms of the last draw. A program keeps its uniform values, and nine of them are the same for every range in a frame. */
  private last: { frame?: DrawParams; w?: Float32Array; d?: Float32Array } = {};
  private readonly wScratch = new Float32Array(64);
  private readonly dScratch = new Float32Array(64);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    for (const n of ['u_centerHi', 'u_centerLo', 'u_linear', 'u_viewport', 'u_arcToPx', 'u_widthPx', 'u_dpr', 'u_miterLimit', 'u_color', 'u_dash']) {
      this.u[n] = gl.getUniformLocation(this.program, n);
    }
    for (const n of ['a_p0', 'a_p1', 'a_arc', 'a_meta', 'a_prev', 'a_next']) this.loc[n] = gl.getAttribLocation(this.program, n);
  }

  /** Needs one guard record on each side of `range` (BufferPool guardBytes = 40). */
  draw(range: Range, p: DrawParams): void {
    const gl = this.gl;
    const count = range.length / SEGMENT_RECORD_BYTES;
    gl.useProgram(this.program);
    const S = SEGMENT_RECORD_BYTES, o = range.offset;
    let byOffset = this.vaos.get(range.buffer);
    let vao = byOffset?.get(o);
    if (!vao) {
      if (this.vaoCount >= MAX_VAOS) this.dropVaos();
      vao = gl.createVertexArray()!;
      this.vaoCount++;
      if (!byOffset) this.vaos.set(range.buffer, (byOffset = new Map()));
      byOffset.set(o, vao);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, range.buffer);
      const attr = (name: string, size: number, off: number, integer = false) => {
        const loc = this.loc[name]!;
        gl.enableVertexAttribArray(loc);
        if (integer) gl.vertexAttribIPointer(loc, size, gl.UNSIGNED_INT, S, off); else gl.vertexAttribPointer(loc, size, gl.FLOAT, false, S, off);
        gl.vertexAttribDivisor(loc, 1);
      };
      attr('a_p0', 4, o); attr('a_p1', 4, o + 16); attr('a_arc', 1, o + 32); attr('a_meta', 1, o + 36, true);
      attr('a_prev', 4, o - S); attr('a_next', 4, o + S + 16);
    } else gl.bindVertexArray(vao);
    // The camera uniforms are the same for every range of a frame (the caller shares one params object per field), so they go once.
    const l = this.last.frame;
    if (!l || l.centerHi !== p.centerHi || l.centerLo !== p.centerLo || l.linear !== p.linear || l.viewport !== p.viewport || l.arcToPx !== p.arcToPx || l.dpr !== p.dpr || l.miterLimit !== p.miterLimit) {
      gl.uniform2fv(this.u.u_centerHi!, p.centerHi); gl.uniform2fv(this.u.u_centerLo!, p.centerLo);
      gl.uniformMatrix2fv(this.u.u_linear!, false, p.linear); gl.uniform2fv(this.u.u_viewport!, p.viewport);
      gl.uniform1f(this.u.u_arcToPx!, p.arcToPx ?? 1); gl.uniform1f(this.u.u_dpr!, p.dpr);
      gl.uniform1f(this.u.u_miterLimit!, p.miterLimit ?? DEFAULTS.miterLimit);
      this.last.frame = { centerHi: p.centerHi, centerLo: p.centerLo, linear: p.linear, viewport: p.viewport, arcToPx: p.arcToPx, dpr: p.dpr, miterLimit: p.miterLimit } as DrawParams;
    }
    // Widths, dashes and colour are uniforms of the program, which keeps the last value set: a range that has the same ones as the
    // range drawn before it (the usual case: one width for every style group) sends nothing.
    const w = this.wScratch; w.fill(0); w.set(p.widthsPx.slice(0, 64));
    const d = this.dScratch; d.fill(0); (p.dashes ?? []).slice(0, 16).forEach((e, i) => d.set(e, i * 4));
    if (!this.widthsSet || !same(w, this.lastWidths)) (gl.uniform1fv(this.u.u_widthPx!, w), this.lastWidths.set(w));
    if (!this.widthsSet || !same(d, this.lastDashes)) (gl.uniform4fv(this.u.u_dash!, d), this.lastDashes.set(d));
    this.widthsSet = true;
    const c = p.color ?? [0, 0, 0, 1];
    if (!this.lastColor || this.lastColor[0] !== c[0] || this.lastColor[1] !== c[1] || this.lastColor[2] !== c[2] || this.lastColor[3] !== c[3]) {
      gl.uniform4fv(this.u.u_color!, c);
      this.lastColor = [c[0], c[1], c[2], c[3]];
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 18, count);
  }

  private dropVaos(): void {
    for (const m of this.vaos.values()) for (const v of m.values()) this.gl.deleteVertexArray(v);
    this.vaos.clear();
    this.vaoCount = 0;
  }

  dispose(): void {
    this.dropVaos();
    if (this.program) this.gl.deleteProgram(this.program);
    this.program = null;
  }
}

const same = (a: Float32Array, b: Float32Array): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram()!;
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  gl.deleteShader(v); gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}
