/**
 * Tile decode, off the main thread (ADR 0005 keeps main-thread work under 1 ms a frame, and one 512 px JPEG decode
 * exceeds that). A worker runs `createImageBitmap` with colour-space conversion off and orientation `none` so an embedded
 * chunk cannot move or recolour a tile, and transfers the `ImageBitmap` back. There is no main-thread fallback: when a
 * worker cannot start the raster is reported, not decoded on the main thread.
 */
export const MIME: Record<number, string> = { 1: "image/png", 2: "image/jpeg", 3: "image/webp" };

export interface Decoded {
  bitmap: ImageBitmap;
  ms: number;
}
export type DecodeReply = { id: number; bitmap: ImageBitmap; ms: number } | { id: number; error: string };
export interface DecodeWorker {
  postMessage(msg: { id: number; bytes: ArrayBuffer; mime: string }, transfer: Transferable[]): void;
  onmessage: ((e: { data: DecodeReply }) => void) | null;
  terminate(): void;
}

/** The worker's whole program, as a string so it needs no bundler entry. Kept in step with `DecodeReply`. */
const WORKER_SOURCE = `
self.onmessage = async (e) => {
  const { id, bytes, mime } = e.data;
  const t0 = performance.now();
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), { colorSpaceConversion: "none", imageOrientation: "none", premultiplyAlpha: "premultiply" });
    self.postMessage({ id, bitmap, ms: performance.now() - t0 }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};`;

export function spawnDecodeWorker(): DecodeWorker {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w as unknown as DecodeWorker;
}

export class DecodePool {
  private readonly workers: DecodeWorker[] = [];
  private readonly waiting = new Map<number, { resolve(d: Decoded): void; reject(e: Error): void }>();
  private next = 0;
  private turn = 0;
  /** Tiles decoded in a worker. */
  decoded = 0;

  constructor(spawn: () => DecodeWorker, size = 2) {
    for (let i = 0; i < size; i++) {
      const w = spawn();
      w.onmessage = (e) => {
        const r = e.data;
        const p = this.waiting.get(r.id);
        if (!p) return void ("bitmap" in r && r.bitmap.close());
        this.waiting.delete(r.id);
        if ("error" in r) p.reject(new Error(r.error));
        else (this.decoded++, p.resolve({ bitmap: r.bitmap, ms: r.ms }));
      };
      this.workers.push(w);
    }
  }

  decode(bytes: Uint8Array, codec: number): Promise<Decoded> {
    const mime = MIME[codec];
    if (!mime) return Promise.reject(new Error(`unknown codec ${codec}`));
    const id = ++this.next;
    const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.workers[this.turn++ % this.workers.length]!.postMessage({ id, bytes: buf, mime }, [buf]);
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const p of this.waiting.values()) p.reject(new Error("disposed"));
    this.waiting.clear();
    this.workers.length = 0;
  }
}
