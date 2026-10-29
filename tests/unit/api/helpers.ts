import { RangeOrigin } from "../helpers/origin";
import { buildPvec, gridSpec, type FixtureSpec } from "../helpers/fixture";

export interface Rig {
  origin: RangeOrigin;
  url: string;
  stop(): Promise<void>;
}
export async function rig(spec: FixtureSpec = gridSpec()): Promise<Rig> {
  const origin = new RangeOrigin(buildPvec(spec).bytes);
  const base = await origin.start();
  return { origin, url: `${base}/p.pvec`, stop: () => origin.stop() };
}

/** Minimal GL: counts creates and deletes per kind. */
export function countingGl(): { gl: WebGL2RenderingContext; live: () => Record<string, number>; canvas: EventTarget } {
  const live: Record<string, number> = {};
  const canvas = new EventTarget();
  const mk = (kind: string) => () => {
    live[kind] = (live[kind] ?? 0) + 1;
    return { kind };
  };
  const del = (kind: string) => () => {
    live[kind] = (live[kind] ?? 0) - 1;
  };
  const gl = {
    canvas,
    createBuffer: mk("buffer"), deleteBuffer: del("buffer"),
    createVertexArray: mk("vao"), deleteVertexArray: del("vao"),
    createTexture: mk("texture"), deleteTexture: del("texture"),
    createProgram: mk("program"), deleteProgram: del("program"),
    createFramebuffer: mk("framebuffer"), deleteFramebuffer: del("framebuffer"),
  } as unknown as WebGL2RenderingContext;
  return { gl, live: () => ({ ...live }), canvas };
}
export const fakeMap = {} as never;
