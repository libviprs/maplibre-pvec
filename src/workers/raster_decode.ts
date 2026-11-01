/**
 * The worker program that decodes raster tiles. It is the only place in the add-on that calls `createImageBitmap`: colour-space
 * conversion off and orientation `none`, so an embedded chunk cannot move or recolour a tile, premultiplied alpha, and the bitmap
 * is transferred back. There is no main-thread fallback: when a worker cannot start the raster is reported, not decoded on the
 * main thread (a guard in tests/conformance keeps decode out of everything outside src/workers).
 */
import type { DecodeWorker } from "../render/raster/decode";

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

