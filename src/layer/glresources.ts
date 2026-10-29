export type GlKind = "framebuffer" | "vao" | "buffer" | "texture" | "program";
/** Deletion order: things that reference others go first. */
const ORDER: GlKind[] = ["framebuffer", "vao", "buffer", "texture", "program"];

type Gl = Pick<WebGLRenderingContext, "deleteFramebuffer" | "deleteBuffer" | "deleteTexture" | "deleteProgram"> &
  Partial<Pick<WebGL2RenderingContext, "deleteVertexArray">>;

/** Owns every GL object the layer creates, so teardown is a loop rather than something remembered. */
export class GlResources {
  private live: Record<GlKind, Set<object>> = { framebuffer: new Set(), vao: new Set(), buffer: new Set(), texture: new Set(), program: new Set() };

  track<T extends object>(kind: GlKind, handle: T): T {
    this.live[kind].add(handle);
    return handle;
  }
  untrack(kind: GlKind, handle: object): void {
    this.live[kind].delete(handle);
  }
  count(kind?: GlKind): number {
    return kind ? this.live[kind].size : ORDER.reduce((n, k) => n + this.live[k].size, 0);
  }
  /** Delete everything still tracked. Safe to call twice. */
  disposeAll(gl: Gl): void {
    const del: Record<GlKind, (h: never) => void> = {
      framebuffer: (h) => gl.deleteFramebuffer(h),
      vao: (h) => gl.deleteVertexArray?.(h),
      buffer: (h) => gl.deleteBuffer(h),
      texture: (h) => gl.deleteTexture(h),
      program: (h) => gl.deleteProgram(h),
    };
    for (const k of ORDER) {
      for (const h of this.live[k]) del[k](h as never);
      this.live[k].clear();
    }
  }
  /** After a context loss every handle is already invalid: forget them without deleting. */
  forgetAll(): void {
    for (const k of ORDER) this.live[k].clear();
  }
}
