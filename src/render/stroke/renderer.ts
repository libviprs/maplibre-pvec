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
  miterLimit?: number;
}
export interface Range { buffer: WebGLBuffer; offset: number; length: number }

/** Draws packed segment ranges with the stroke program. One VAO, rebound per range. */
export class StrokeRenderer {
  private program: WebGLProgram | null;
  private vao: WebGLVertexArrayObject | null;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.vao = gl.createVertexArray();
    for (const n of ['u_centerHi', 'u_centerLo', 'u_linear', 'u_viewport', 'u_arcToPx', 'u_widthPx', 'u_dpr', 'u_miterLimit', 'u_color', 'u_dash']) {
      this.u[n] = gl.getUniformLocation(this.program, n);
    }
  }

  /** Needs one guard record on each side of `range` (BufferPool guardBytes = 40). */
  draw(range: Range, p: DrawParams): void {
    const gl = this.gl;
    const count = range.length / SEGMENT_RECORD_BYTES;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, range.buffer);
    const S = SEGMENT_RECORD_BYTES, o = range.offset;
    const attr = (name: string, size: number, off: number, integer = false) => {
      const loc = gl.getAttribLocation(this.program!, name);
      gl.enableVertexAttribArray(loc);
      if (integer) gl.vertexAttribIPointer(loc, size, gl.UNSIGNED_INT, S, off); else gl.vertexAttribPointer(loc, size, gl.FLOAT, false, S, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr('a_p0', 4, o); attr('a_p1', 4, o + 16); attr('a_arc', 1, o + 32); attr('a_meta', 1, o + 36, true);
    attr('a_prev', 4, o - S); attr('a_next', 4, o + S + 16);
    gl.uniform2fv(this.u.u_centerHi!, p.centerHi); gl.uniform2fv(this.u.u_centerLo!, p.centerLo);
    gl.uniformMatrix2fv(this.u.u_linear!, false, p.linear); gl.uniform2fv(this.u.u_viewport!, p.viewport);
    gl.uniform1f(this.u.u_arcToPx!, p.arcToPx ?? 1); gl.uniform1f(this.u.u_dpr!, p.dpr);
    gl.uniform1f(this.u.u_miterLimit!, p.miterLimit ?? DEFAULTS.miterLimit);
    const w = new Float32Array(64); w.set(p.widthsPx.slice(0, 64));
    gl.uniform1fv(this.u.u_widthPx!, w);
    const d = new Float32Array(64); (p.dashes ?? []).slice(0, 16).forEach((e, i) => d.set(e, i * 4));
    gl.uniform4fv(this.u.u_dash!, d);
    gl.uniform4fv(this.u.u_color!, p.color ?? [0, 0, 0, 1]);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 18, count);
  }

  dispose(): void {
    if (this.vao) this.gl.deleteVertexArray(this.vao);
    if (this.program) this.gl.deleteProgram(this.program);
    this.vao = null; this.program = null;
  }
}

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
