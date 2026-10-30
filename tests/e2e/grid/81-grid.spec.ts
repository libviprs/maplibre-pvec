import { expect, test, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { COMPAT } from "../../../src/compat/matrix";

// Issue 81: the browser grid. One project per engine (grid-chromium, grid-chromium-min, grid-firefox,
// grid-webkit) runs every test here, and each test names the MapLibre version it drove. Launch through
// /Users/rom/workspace/xdg-pw-lock.sh. The Firefox project needs an X display (xvfb-run) for WebGL2.
const bundle = (entry: string) => buildSync({ entryPoints: [resolve(entry)], bundle: true, format: "iife", globalName: "H", write: false }).outputFiles[0]!.text;
const stroke = bundle("tests/e2e/harness/entry.ts");
const transport = bundle("tests/e2e/harness/transport.ts");
const DIRS: Record<string, string> = { "4": "v4", "5": "v5", "6": "v6" };

const note = async (page: Page, browserName: string, extra: Record<string, unknown>) => {
  const info = test.info();
  const version = await page.evaluate(() => navigator.userAgent);
  info.annotations.push({ type: "grid", description: JSON.stringify({ engine: browserName, ua: version, kind: info.project.name.startsWith("isolated") ? "isolated" : "grid", ...extra }) });
};

test.describe("#81 browser grid", () => {
  test("WebGL2 stroke pipeline: width, no GL error, no leaked state", async ({ page, browser, browserName }) => {
    await page.goto("/app/grid.html");
    await page.addScriptTag({ content: stroke });
    const r = await page.evaluate(() => (window as any).H.render({ size: 200, lines: [{ points: [40, 100, 160, 100], widthCss: 4 }, { points: [40, 40, 120, 120], widthCss: 4 }] }));
    expect(r.glError).toBe(0);
    expect(r.stateDiffs).toEqual([]);
    const sum = r.alpha.reduce((a: number, b: number) => a + b, 0) / 255;
    expect(sum / (120 + 80 * Math.SQRT2)).toBeGreaterThan(3.5);
    expect(sum / (120 + 80 * Math.SQRT2)).toBeLessThan(4.5);
    await note(page, browserName, { version: browser.version(), maplibre: null, renderer: r.renderer, arch: process.arch });
  });

  test("module workers, the WebAssembly MVP and the transfer transport", async ({ page, browser, browserName }) => {
    await page.goto("/app/grid.html");
    await page.addScriptTag({ content: transport });
    const r = await page.evaluate(async () => {
      const url = URL.createObjectURL(new Blob(["self.onmessage = (e) => postMessage(e.data * 2);"], { type: "text/javascript" }));
      const w = new Worker(url, { type: "module" });
      const doubled = await new Promise<number>((res, rej) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => rej(new Error(String(e.message))); w.postMessage(21); });
      w.terminate();
      const wasm = await WebAssembly.instantiate(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
      return { doubled, wasm: wasm instanceof WebAssembly.Instance || typeof wasm === "object", transport: (window as any).H.chooseTransport(), isolated: self.crossOriginIsolated };
    });
    expect(r.doubled).toBe(42);
    expect(r.wasm).toBe(true);
    expect(r.isolated).toBe(false);
    expect(r.transport).toBe("transfer");
    await note(page, browserName, { version: browser.version(), maplibre: null, arch: process.arch });
  });

  for (const row of COMPAT.maplibre) {
    test(`MapLibre ${row.version}: onAdd gets WebGL2, render args and matrix within 1 device px`, async ({ page, browser, browserName }) => {
      await page.goto("/app/grid.html");
      const r = await page.evaluate((d) => (window as any).runMapLibre(d), DIRS[row.version.split(".")[0]!]);
      expect(r.version).toBe(row.version);
      expect(r.hooks).toEqual([{ ctor: "WebGL2RenderingContext", isWebGL2: true }]);
      expect(r.glErrors).toEqual([]);
      expect(r.renderArgs).toContain(row.renderArgs.startsWith("number") ? "number[16]" : "defaultProjectionData.mainMatrix");
      expect(r.centroid.n).toBeGreaterThan(0);
      expect(Math.hypot(r.centroid.x - r.expected.x, r.centroid.y - r.expected.y)).toBeLessThan(1);
      await note(page, browserName, { version: browser.version(), maplibre: row.version, renderer: r.renderer, arch: process.arch });
    });
  }
});
