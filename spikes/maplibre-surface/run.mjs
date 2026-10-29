// Throwaway spike runner (M1.1). Runs in the Playwright container; writes results.json.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const VERSIONS = { v4: "maplibre-gl-v4", v5: "maplibre-gl-v5", v6: "maplibre-gl-v6" };
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".mjs": "text/javascript", ".map": "application/json" };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let f;
  const m = u.pathname.match(/^\/(v\d)\/(.*)$/);
  if (u.pathname === "/harness.html") f = path.join(here, "harness.html");
  else if (m && VERSIONS[m[1]]) f = path.join(root, "node_modules", VERSIONS[m[1]], m[2]);
  if (!f || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }).end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const results = { browser: `chromium ${browser.version()}`, renderer: "SwiftShader software GL (arm64/x64 container, no GPU)", versions: {} };

async function open(v, dpr) {
  const ctx = await browser.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(String(e)));
  await page.goto(`${base}/harness.html?v=${v}`);
  await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 30000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(`${v}: ${err}`);
  return { ctx, page, errs };
}
const idle = (page) => page.evaluate(() => new Promise(r => window.map.once("idle", r)));
const wait = (page, ms) => page.waitForTimeout(ms);

for (const v of Object.keys(VERSIONS)) {
  const out = (results.versions[v] = {});
  try {
    // A. hooks, args, accuracy at zoom 14, dpr 1 and 2
    out.accuracy = {};
    for (const dpr of [1, 2]) {
      const { ctx, page, errs } = await open(v, dpr);
      const r = await page.evaluate(async () => {
        const L = window.__makeLayer("probe", [0, 0, 1], 30, { measure: true });
        window.map.addLayer(L);
        await new Promise(r => window.map.once("idle", r));
        const p = window.map.project([8.5417, 47.3769]);
        const dprv = window.devicePixelRatio;
        const c = L.__st.centroid;
        const gl = window.map.getCanvas().getContext("webgl2");
        return {
          version: window.__log.version, dpr: dprv, hooks: window.__log.hooks.filter(h => h.hook === "onAdd"),
          prerenderArgs: window.__log.prerenderArgs, renderArgs: window.__log.renderArgs, matrixKind: L.__st.matrixKind,
          centroid: c, expected: { x: p.x * dprv, y: p.y * dprv },
          errPx: c && c.n ? Math.hypot(c.x - p.x * dprv, c.y - p.y * dprv) : null,
          sameContextAsCanvasWebgl2: gl === L.__st.gl, zoom: window.map.getZoom(),
          renderStateAfter: window.__log.renderStateAfter,
        };
      });
      r.pageErrors = errs;
      out.accuracy[`dpr${dpr}`] = r;
      await ctx.close();
    }
    out.version = out.accuracy.dpr1.version;

    // B. ordering, renderingMode
    {
      const { ctx, page } = await open(v, 1);
      out.ordering = await page.evaluate(async () => {
        const res = {};
        const sample = async (label, id, mode, before) => {
          const L = window.__makeLayer(id, [0, 0, 1], 200, { mode });
          window.map.addLayer(L, before);
          await new Promise(r => window.map.once("idle", r));
          window.map.triggerRepaint();
          await new Promise(r => window.map.once("idle", r));
          const gl = window.map.getCanvas().getContext("webgl2");
          const p = window.map.project([8.5417, 47.3769]);
          // Read through a 2D copy so we see the composited canvas.
          const c2 = document.createElement("canvas"); c2.width = 512; c2.height = 512;
          const ctx2 = c2.getContext("2d"); ctx2.drawImage(window.map.getCanvas(), 0, 0);
          const px = (x, y) => Array.from(ctx2.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3));
          res[label] = { center: px(p.x, p.y), offBand: px(p.x, p.y + 28) };
          window.map.removeLayer(id);
        };
        await sample("below_line_above_fill_2d", "o1", "2d", "line");
        await sample("top_2d", "o2", "2d", undefined);
        await sample("below_line_3d", "o3", "3d", "line");
        await sample("top_3d", "o4", "3d", undefined);
        await sample("below_fill_2d", "o5", "2d", "fill");
        return res;
      });
      await ctx.close();
    }

    // C. repaint model and per-frame cost
    {
      const { ctx, page } = await open(v, 1);
      out.repaint = await page.evaluate(async () => {
        const L = window.__makeLayer("rp", [0, 0, 1], 30, { loop: false });
        window.map.addLayer(L);
        await new Promise(r => window.map.once("idle", r));
        const log = window.__log, sleep = ms => new Promise(r => setTimeout(r, ms));
        const o = {};
        // idle: no repaint source
        let r0 = log.counters.render, p0 = log.counters.prerender; await sleep(2000);
        o.idle2s = { renders: log.counters.render - r0, prerenders: log.counters.prerender - p0 };
        // on-demand: 30 triggerRepaint calls spaced 50 ms
        r0 = log.counters.render; p0 = log.counters.prerender; log.renderMsSum = 0;
        for (let i = 0; i < 30; i++) { window.map.triggerRepaint(); await sleep(50); }
        o.onDemand30 = { renders: log.counters.render - r0, prerenders: log.counters.prerender - p0, meanRenderMs: log.renderMsSum / Math.max(1, log.counters.render - r0) };
        // self-driven loop
        L.__st.loop = true; window.map.triggerRepaint();
        await sleep(300);
        r0 = log.counters.render; p0 = log.counters.prerender; log.renderMsSum = 0; const t0 = performance.now();
        await sleep(3000);
        const dt = performance.now() - t0, n = log.counters.render - r0;
        o.selfLoop3s = { renders: n, prerenders: log.counters.prerender - p0, fps: n / (dt / 1000), meanRenderMs: log.renderMsSum / Math.max(1, n) };
        L.__st.loop = false;
        // pan: prerender/render inputs
        return o;
      });
      await ctx.close();
    }

    // D. context loss
    {
      const { ctx, page } = await open(v, 1);
      out.contextLoss = await page.evaluate(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const L = window.__makeLayer("cl", [0, 0, 1], 30, { loop: false });
        window.map.addLayer(L);
        await new Promise(r => window.map.once("idle", r));
        const st = L.__st, log = window.__log, gl = st.gl;
        const ext = gl.getExtension("WEBGL_lose_context");
        const before = { program: gl.isProgram(st.prog), buffer: gl.isBuffer(st.buf), vao: gl.isVertexArray(st.vao) };
        const hooksBefore = log.hooks.length, r0 = log.counters.render;
        ext.loseContext(); await sleep(500);
        const during = { program: gl.isProgram(st.prog), buffer: gl.isBuffer(st.buf), vao: gl.isVertexArray(st.vao), isContextLost: gl.isContextLost() };
        const r1 = log.counters.render;
        ext.restoreContext(); await sleep(2500);
        window.map.triggerRepaint(); await sleep(500);
        const gl2 = window.map.getCanvas().getContext("webgl2");
        const after = { program: gl2.isProgram(st.prog), buffer: gl2.isBuffer(st.buf), vao: gl2.isVertexArray(st.vao), sameGlObject: gl2 === gl };
        return { before, during, after, hooksDuring: log.hooks.slice(hooksBefore).map(h => h.hook), rendersSinceRestore: log.counters.render - r1, rendersBeforeLoss: r0, rendersWhileLost: r1 - r0 };
      });
      await ctx.close();
    }
  } catch (e) { out.error = String(e && e.stack || e); }
}

await browser.close(); server.close();
fs.writeFileSync(path.join(here, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
