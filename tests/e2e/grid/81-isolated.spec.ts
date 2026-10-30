import { expect, test } from "@playwright/test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { COMPAT } from "../../../src/compat/matrix";

// Issue 81, informational. The same engines against an origin that sends COOP same-origin and COEP
// require-corp (the /iso/ prefix of tools/fixture-origin.mjs). The add-on never requires isolation;
// this run shows what happens when a host page has it. Its result is reported, not gated.
const transport = buildSync({ entryPoints: [resolve("tests/e2e/harness/transport.ts")], bundle: true, format: "iife", globalName: "H", write: false }).outputFiles[0]!.text;
const highest = COMPAT.maplibre[COMPAT.maplibre.length - 1]!.version;

test.describe("#81 COOP/COEP isolated run (informational)", () => {
  test("crossOriginIsolated turns on the shared transport and a shared buffer reaches a module worker", async ({ page, browser, browserName }) => {
    await page.goto("/app/grid.html");
    await page.addScriptTag({ content: transport });
    const r = await page.evaluate(async () => {
      const sab = new SharedArrayBuffer(8), view = new Int32Array(sab);
      const url = URL.createObjectURL(new Blob(["self.onmessage = (e) => { const v = new Int32Array(e.data); Atomics.store(v, 0, 7); postMessage('done'); };"], { type: "text/javascript" }));
      const w = new Worker(url, { type: "module" });
      await new Promise<void>((res, rej) => { w.onmessage = () => res(); w.onerror = (e) => rej(new Error(String(e.message))); w.postMessage(sab); });
      w.terminate();
      return { isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, transport: (window as any).H.chooseTransport(), seen: Atomics.load(view, 0) };
    });
    expect(r).toEqual({ isolated: true, sab: "function", transport: "shared", seen: 7 });
    test.info().annotations.push({ type: "grid", description: JSON.stringify({ engine: browserName, kind: "isolated", version: browser.version(), maplibre: null, arch: process.arch }) });
  });

  test(`MapLibre ${highest} still hands onAdd a WebGL2 context under isolation`, async ({ page, browser, browserName }) => {
    await page.goto("/app/grid.html");
    const r = await page.evaluate(() => (window as any).runMapLibre("v6"));
    expect(r.hooks).toEqual([{ ctor: "WebGL2RenderingContext", isWebGL2: true }]);
    expect(r.centroid.n).toBeGreaterThan(0);
    test.info().annotations.push({ type: "grid", description: JSON.stringify({ engine: browserName, kind: "isolated", version: browser.version(), maplibre: highest, arch: process.arch }) });
  });
});
