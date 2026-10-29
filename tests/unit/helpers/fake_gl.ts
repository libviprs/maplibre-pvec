// Minimal in-memory GL stand-in. It keeps buffer contents so tests can compare bytes,
// and implements just enough state to exercise the pool and the state guard.
export class FakeGl {
  readonly ARRAY_BUFFER = 0x8892;
  readonly STATIC_DRAW = 0x88e4;
  readonly BLEND = 0x0be2;
  readonly DEPTH_TEST = 0x0b71;
  readonly STENCIL_TEST = 0x0b90;
  readonly CULL_FACE = 0x0b44;
  readonly SCISSOR_TEST = 0x0c11;
  readonly CURRENT_PROGRAM = 0x8b8d;
  readonly VERTEX_ARRAY_BINDING = 0x85b5;
  readonly ARRAY_BUFFER_BINDING = 0x8894;
  readonly BLEND_SRC_RGB = 0x80c9;
  readonly BLEND_DST_RGB = 0x80c8;
  readonly BLEND_EQUATION_RGB = 0x8009;
  readonly DEPTH_WRITEMASK = 0x0b72;
  readonly DEPTH_FUNC = 0x0b74;
  readonly STENCIL_FUNC = 0x0b92;
  readonly STENCIL_REF = 0x0b97;
  readonly STENCIL_VALUE_MASK = 0x0b93;
  readonly STENCIL_WRITEMASK = 0x0b98;
  readonly COLOR_WRITEMASK = 0x0c23;
  readonly VIEWPORT = 0x0ba2;
  readonly SCISSOR_BOX = 0x0c10;
  readonly ACTIVE_TEXTURE = 0x84e0;
  readonly TEXTURE_BINDING_2D = 0x8069;
  readonly UNPACK_FLIP_Y_WEBGL = 0x9240;
  readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
  readonly UNPACK_ALIGNMENT = 0x0cf5;

  nextId = 1;
  buffers = new Map<number, Uint8Array>();
  boundArray: number | null = null;
  errors = 0;
  caps = new Set<number>();
  params = new Map<number, unknown>();

  constructor() {
    this.params.set(this.CURRENT_PROGRAM, null);
    this.params.set(this.VERTEX_ARRAY_BINDING, null);
    this.params.set(this.BLEND_SRC_RGB, 1);
    this.params.set(this.BLEND_DST_RGB, 0);
    this.params.set(this.BLEND_EQUATION_RGB, 0x8006);
    this.params.set(this.DEPTH_WRITEMASK, true);
    this.params.set(this.DEPTH_FUNC, 0x0201);
    this.params.set(this.STENCIL_FUNC, 0x0207);
    this.params.set(this.STENCIL_REF, 0);
    this.params.set(this.STENCIL_VALUE_MASK, 0xff);
    this.params.set(this.STENCIL_WRITEMASK, 0xff);
    this.params.set(this.COLOR_WRITEMASK, [true, true, true, true]);
    this.params.set(this.VIEWPORT, [0, 0, 300, 150]);
    this.params.set(this.SCISSOR_BOX, [0, 0, 300, 150]);
    this.params.set(this.ACTIVE_TEXTURE, 0x84c0);
    this.params.set(this.TEXTURE_BINDING_2D, null);
    this.params.set(this.UNPACK_FLIP_Y_WEBGL, false);
    this.params.set(this.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.params.set(this.UNPACK_ALIGNMENT, 4);
  }
  // pool surface
  createBuffer() { const id = this.nextId++; this.buffers.set(id, new Uint8Array(0)); return id; }
  deleteBuffer(b: number) { this.buffers.delete(b); }
  bindBuffer(_t: number, b: number | null) { this.boundArray = b; this.params.set(this.ARRAY_BUFFER_BINDING, b); }
  bufferData(_t: number, size: number, _u: number) {
    if (this.boundArray == null) { this.errors++; return; }
    this.buffers.set(this.boundArray, new Uint8Array(size));
  }
  bufferSubData(_t: number, offset: number, data: Uint8Array) {
    const buf = this.boundArray == null ? undefined : this.buffers.get(this.boundArray);
    if (!buf || offset + data.byteLength > buf.byteLength) { this.errors++; return; }
    buf.set(data, offset);
  }
  getError() { const e = this.errors; this.errors = 0; return e ? 0x0500 : 0; }
  // state surface
  isEnabled(c: number) { return this.caps.has(c); }
  enable(c: number) { this.caps.add(c); }
  disable(c: number) { this.caps.delete(c); }
  getParameter(p: number) { return this.params.get(p); }
  useProgram(p: unknown) { this.params.set(this.CURRENT_PROGRAM, p); }
  bindVertexArray(v: unknown) { this.params.set(this.VERTEX_ARRAY_BINDING, v); }
  blendFunc(s: number, d: number) { this.params.set(this.BLEND_SRC_RGB, s); this.params.set(this.BLEND_DST_RGB, d); }
  blendEquation(e: number) { this.params.set(this.BLEND_EQUATION_RGB, e); }
  depthMask(m: boolean) { this.params.set(this.DEPTH_WRITEMASK, m); }
  depthFunc(f: number) { this.params.set(this.DEPTH_FUNC, f); }
  stencilFunc(f: number, r: number, m: number) {
    this.params.set(this.STENCIL_FUNC, f); this.params.set(this.STENCIL_REF, r); this.params.set(this.STENCIL_VALUE_MASK, m);
  }
  stencilMask(m: number) { this.params.set(this.STENCIL_WRITEMASK, m); }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean) { this.params.set(this.COLOR_WRITEMASK, [r, g, b, a]); }
  viewport(x: number, y: number, w: number, h: number) { this.params.set(this.VIEWPORT, [x, y, w, h]); }
  scissor(x: number, y: number, w: number, h: number) { this.params.set(this.SCISSOR_BOX, [x, y, w, h]); }
  activeTexture(t: number) { this.params.set(this.ACTIVE_TEXTURE, t); }
  bindTexture(_t: number, tex: unknown) { this.params.set(this.TEXTURE_BINDING_2D, tex); }
  pixelStorei(p: number, v: unknown) { this.params.set(p, v); }
}
