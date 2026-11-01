import { TieredCache } from "../../../src/source/cache";
import type { Mat6, RasterPlacement } from "../../../src/render/raster/geometry";
import type { DecodeReply, DecodeWorker } from "../../../src/render/raster/decode";
import type { RasterProvider } from "../../../src/render/raster/provider";
import { RasterRenderer, type RasterFrame, type RasterFrameStats } from "../../../src/render/raster/renderer";
import { RasterRefusedError } from "../../../src/render/raster/provider";

// A raster renderer with nothing real under it: a counting GL, decode workers whose replies the test releases by hand, and a
// provider that logs every request. The bytes of every object are known, so a test totals them without asking the cache.

export const EDGE = 256;
export const TILE = EDGE * EDGE * 4;

export function placement(id: number, over: Partial<RasterPlacement> = {}): RasterPlacement {
  return { id, pixelToSource: [1, 0, 0, 1, 0, 0], width: 2048, height: 2048, visibleBox: [0, 0, 2048, 2048], tileEdge: EDGE, levels: 4, codec: 1, channels: 4, bitDepth: 8, opacity: 255, band: 0, ...over };
}

export interface FakeBitmap { width: number; height: number; closed: boolean; close(): void }

export class Rig {
  readonly cache: TieredCache;
  readonly renderer: RasterRenderer;
  /** Every tile the provider was asked for. */
  readonly requests: string[] = [];
  readonly bitmaps: FakeBitmap[] = [];
  readonly textures = new Set<object>();
  readonly texturesEver: object[] = [];
  readonly pending: { id: number; key: string }[] = [];
  /** Every decode the pool posted, in order. */
  readonly posted: string[] = [];
  readonly stats: RasterFrameStats[] = [];
  readonly errors: unknown[] = [];
  /** The refusals the renderer reported: one per refused raster. */
  readonly refused: { rasterId: number; rule: string; message: string }[] = [];
  /** Decodes answered with an error instead of a bitmap, while true. */
  failDecodes = false;
  /** Rasters whose `tile()` rejects with a refusal naming this rule. */
  refuse = new Map<number, string>();
  /** Every vertex buffer the renderer sent to the GPU, in order. */
  readonly vertexUploads: Float32Array[] = [];
  /** Where the georeference puts the drawing: added to every corner's world position. */
  world: [number, number] = [0, 0];
  private readonly workers: FakeWorker[] = [];
  private readonly encodedLen = new Map<string, number>();
  /** Camera: device pixels per source unit and the source point at the centre. */
  scale = 1;
  cx = 1024;
  cy = 1024;
  viewport: [number, number] = [1024, 768];

  constructor(public readonly placements: RasterPlacement[], o: { gpuBytes?: number; decodedBytes?: number; compressedBytes?: number; maxDecodedBytes?: number } = {}) {
    this.cache = new TieredCache({ gpu: o.gpuBytes ?? 128 * 1024 * 1024, decoded: o.decodedBytes ?? 128 * 1024 * 1024, compressed: o.compressedBytes ?? 64 * 1024 * 1024 });
    const provider: RasterProvider = {
      placements: () => this.placements,
      tile: (id, level, col, row) => {
        const k = `r${id}/${level}/${col}/${row}`;
        this.requests.push(k);
        const rule = this.refuse.get(id);
        if (rule) return Promise.reject(new RasterRefusedError(rule, `${rule}: the module refused raster ${id}`));
        const n = 200 + ((id * 131 + level * 31 + col * 7 + row) % 50);
        this.encodedLen.set(k, n);
        // the first four bytes name the tile, so a fake worker knows which tile it holds
        return Promise.resolve(Uint8Array.from({ length: n }, (_, i) => (i === 0 ? id : i === 1 ? level : i === 2 ? col : i === 3 ? row : 1)));
      },
    };
    const gl = glStub(this);
    this.renderer = new RasterRenderer({
      gl,
      cache: this.cache,
      provider,
      map: { triggerRepaint: () => undefined },
      spawn: () => {
        const w = new FakeWorker(this);
        this.workers.push(w);
        return w;
      },
      onError: (_where, e) => void this.errors.push(e),
      onRefused: (e) => void this.refused.push(e),
      onFrame: (s) => void this.stats.push(s),
      ...(o.maxDecodedBytes !== undefined ? { maxDecodedBytes: o.maxDecodedBytes } : {}),
    });
  }

  frame(): RasterFrame {
    const s = this.scale;
    const [w, h] = this.viewport;
    return {
      centerHi: [0, 0],
      centerLo: [0, 0],
      linear: [1, 0, 0, 1],
      viewport: [w, h],
      dpr: 1,
      sourceToDevice: (): Mat6 => [s, 0, 0, s, w / 2 - this.cx * s, h / 2 - this.cy * s],
      sourceToWorld: (x, y) => [x / 1e6 + this.world[0], y / 1e6 + this.world[1]],
    };
  }

  /** One frame the way the engine drives it. */
  step(): void {
    const f = this.frame();
    this.renderer.prepare(f);
    this.renderer.draw(0, f);
    this.renderer.draw(1, f);
    this.renderer.endFrame();
  }

  /** Let the promises of fetch and decode settle. */
  async tick(n = 6): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  /** Release `n` pending decodes (all when omitted) in the order given by `pick` (oldest first by default), only those `want` accepts. */
  deliver(n = Infinity, pick: (len: number) => number = () => 0, want: (key: string) => boolean = () => true): number {
    let done = 0;
    for (;;) {
      const ok = this.pending.map((p, i) => [p, i] as const).filter(([p]) => want(p.key));
      if (done >= n || !ok.length) return done;
      const [p] = this.pending.splice(ok[pick(ok.length)]![1], 1);
      this.workers.find((x) => x.has(p!.id))!.reply(p!.id);
      done++;
    }
  }

  /** Bytes by independent count: what is alive, not what the cache says. */
  independent(): { compressed: number; decoded: number; gpu: number } {
    let compressed = 0;
    for (const k of this.cache.keys("compressed")) compressed += this.encodedLen.get(k) ?? 0;
    const decoded = this.bitmaps.filter((b) => !b.closed).length * TILE;
    return { compressed, decoded, gpu: this.textures.size * TILE };
  }

  postBitmap(): FakeBitmap {
    const b: FakeBitmap = { width: EDGE, height: EDGE, closed: false, close() { b.closed = true; } };
    this.bitmaps.push(b);
    return b;
  }
}

class FakeWorker implements DecodeWorker {
  onmessage: ((e: { data: DecodeReply }) => void) | null = null;
  private held = new Map<number, string>();
  constructor(private readonly rig: Rig) {}
  has(id: number): boolean {
    return this.held.has(id);
  }
  postMessage(msg: { id: number; bytes: ArrayBuffer; mime: string }): void {
    const b = new Uint8Array(msg.bytes);
    const key = `r${b[0]}/${b[1]}/${b[2]}/${b[3]}`;
    this.held.set(msg.id, key);
    this.rig.posted.push(key);
    this.rig.pending.push({ id: msg.id, key });
  }
  reply(id: number): void {
    this.held.delete(id);
    if (this.rig.failDecodes) return void this.onmessage?.({ data: { id, error: "EncodingError: the source image cannot be decoded" } });
    this.onmessage?.({ data: { id, bitmap: this.rig.postBitmap() as never, ms: 1 } });
  }
  terminate(): void {}
}

function glStub(rig: Rig): WebGL2RenderingContext {
  const impl: Record<string, unknown> = {
    createTexture: () => {
      const t = {};
      rig.textures.add(t);
      rig.texturesEver.push(t);
      return t;
    },
    deleteTexture: (t: object) => void rig.textures.delete(t),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    createShader: () => ({}),
    createProgram: () => ({}),
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    getUniformLocation: () => ({}),
    bufferData: (_target: number, data: ArrayBufferView) => void rig.vertexUploads.push(Float32Array.from(data as unknown as Float32Array)),
  };
  return new Proxy(impl, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z][A-Z0-9_]*$/.test(k) ? 1 : () => undefined),
  }) as unknown as WebGL2RenderingContext;
}
