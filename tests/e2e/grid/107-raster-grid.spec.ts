import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// Issue 107 (RM1.5): the browser is the decoder, so what createImageBitmap does with each tile variant ADR 0018 allows, in each engine
// the matrix supports, is part of the contract. One project per engine runs this (tools/run-grid.sh); each test names the engine,
// the version and the architecture it ran on. Launch through /Users/rom/workspace/xdg-pw-lock.sh. Firefox needs the X display
// xvfb-run gives it for WebGL2.
interface Fixture {
  bytes: number;
  sha256: string;
  codec: "png" | "jpeg" | "webp";
  width: number;
  height: number;
  /** How far a decoded channel may sit from the stored one: 0 for lossless, a few levels for lossy codecs. */
  slack: number;
  expected: { x: number; y: number; rgba: number[] }[];
}
const index = JSON.parse(readFileSync("tests/fixtures/raster/index.json", "utf8")) as { files: Record<string, Fixture> };
const b64 = (name: string) => readFileSync(`tests/fixtures/raster/${name}`).toString("base64");
const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

const note = async (page: Page, browserName: string, extra: Record<string, unknown>) => {
  const info = test.info();
  const ua = await page.evaluate(() => navigator.userAgent);
  info.annotations.push({ type: "grid", description: JSON.stringify({ engine: browserName, ua, kind: "grid", arch: process.arch, ...extra }) });
};

/** In the page: a module worker decodes with the three options, transfers the bitmap, the page uploads it and reads the pixels back. */
async function decode(page: Page, items: { name: string; mime: string; b64: string; at: { x: number; y: number }[] }[]) {
  return page.evaluate(async (list) => {
    const src = `self.onmessage = async (e) => {
      const { id, bytes, mime } = e.data;
      try {
        const bm = await createImageBitmap(new Blob([bytes], { type: mime }), { colorSpaceConversion: "none", imageOrientation: "none", premultiplyAlpha: "premultiply" });
        self.postMessage({ id, bm, w: bm.width, h: bm.height, neutered: false }, [bm]);
      } catch (err) { self.postMessage({ id, error: String(err) }); }
    };`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl2")!;
    const out: Record<string, unknown> = { renderer: gl ? String(gl.getParameter(gl.RENDERER)) : null };
    for (const [id, it] of list.entries()) {
      const bytes = Uint8Array.from(atob(it.b64), (c) => c.charCodeAt(0));
      const reply = await new Promise<{ bm?: ImageBitmap; w?: number; h?: number; error?: string }>((res, rej) => {
        worker.onmessage = (e) => res(e.data);
        worker.onerror = (e) => rej(new Error(String(e.message)));
        worker.postMessage({ id, bytes, mime: it.mime }, [bytes.buffer]);
      });
      if (reply.error || !reply.bm) {
        out[it.name] = { error: reply.error ?? "no bitmap" };
        continue;
      }
      const bm = reply.bm;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bm);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const px: number[][] = [];
      for (const p of it.at) {
        const b = new Uint8Array(4);
        // texture row 0 is the image's top row (UNPACK_FLIP_Y is false), so a pixel row y is texture row y
        if (complete) gl.readPixels(p.x, p.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
        px.push(Array.from(b));
      }
      out[it.name] = { w: bm.width, h: bm.height, px, complete, glError: gl.getError() };
      bm.close();
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(tex);
    }
    worker.terminate();
    URL.revokeObjectURL(url);
    return out as Record<string, { w: number; h: number; px: number[][]; complete: boolean; glError: number; error?: string }> & { renderer: string };
  }, items);
}

const VARIANTS = Object.entries(index.files).filter(([n]) => !/1024|srgb|iccp/.test(n));

test.describe("#107 raster decode grid", () => {
  test("every tile variant ADR 0018 allows decodes in a module worker to its size and pixels, transfers, and uploads (createImageBitmap none, none, premultiply)", async ({ page, browser, browserName }) => {
    await page.goto("/app/grid.html");
    const r = await decode(page, VARIANTS.map(([name, f]) => ({ name, mime: MIME[f.codec], b64: b64(name), at: f.expected.map(({ x, y }) => ({ x, y })) })));
    const rows: Record<string, string> = {};
    for (const [name, f] of VARIANTS) {
      const got = r[name]!;
      expect(got.error, `${name} decodes`).toBeUndefined();
      expect([got.w, got.h], `${name} size`).toEqual([f.width, f.height]);
      expect(got.complete).toBe(true);
      expect(got.glError, `${name} upload`).toBe(0);
      f.expected.forEach((e, i) => {
        for (let k = 0; k < 4; k++) expect(Math.abs(got.px[i]![k]! - e.rgba[k]!), `${name} sample ${i} channel ${k}: ${got.px[i]} against ${e.rgba}`).toBeLessThanOrEqual(f.slack);
      });
      rows[name] = "ok";
    }
    await note(page, browserName, { version: browser.version(), maplibre: null, renderer: r.renderer, variants: Object.keys(rows).length });
  });

  test("colour chunks do not recolour a tile under colorSpaceConversion none; an engine that applies them anyway is recorded", async ({ page, browser, browserName }) => {
    await page.goto("/app/grid.html");
    const names = ["png-rgb-8.png", "png-rgb-8-srgb-gama.png", "png-rgb-8-iccp.png"];
    const r = await decode(page, names.map((name) => ({ name, mime: "image/png", b64: b64(name), at: index.files[name]!.expected.map(({ x, y }) => ({ x, y })) })));
    const plain = r["png-rgb-8.png"]!;
    const recoloured: string[] = [];
    for (const n of names.slice(1)) {
      expect(r[n]!.error, n).toBeUndefined();
      const moved = r[n]!.px.some((p, i) => p.some((v, k) => Math.abs(v - plain.px[i]![k]!) > 2));
      if (moved) recoloured.push(n);
    }
    // the stored pixels are what the fixture index says, whatever a profile would have done
    index.files["png-rgb-8.png"]!.expected.forEach((e, i) => e.rgba.forEach((v, k) => expect(Math.abs(plain.px[i]![k]! - v)).toBeLessThanOrEqual(2)));
    if (browserName === "chromium") expect(recoloured, "chromium honours none").toEqual([]);
    await note(page, browserName, {
      version: browser.version(),
      maplibre: null,
      colourChunks: recoloured.length ? `recoloured despite colorSpaceConversion none: ${recoloured.join(", ")} (the producer strips colour chunks, libviprs#1330, and is the cover)` : "not recoloured under none",
    });
  });
});
